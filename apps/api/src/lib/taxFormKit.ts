import type { Kit } from './docKit/index.js';
import { COLOR, SIZE, createDoc, fmt } from './docKit/index.js';
import type { W2Boxes } from './w2Aggregator.js';

/**
 * Drawing for substitute tax-form copies furnished to employees and
 * recipients (W-2 Copies B, C and 2; W-2c; 1099 Copy B).
 *
 * IRS Pub 1141 (2026) §2.3 governs employee copies of Form W-2, and these
 * parts follow it:
 *  - white paper, black ink only — no brand colour, no logo on a copy
 *    (the employer's name may appear; a branded cover letter is a
 *    permissible enclosure, so the logo lives there);
 *  - boxes, box numbers and titles match the official form; the core boxes
 *    1–6 sit upper right (or across the top in the vertical format), with
 *    nothing to their right; identifying boxes a, b, c, e, f sit to the
 *    left or below, never top right;
 *  - form number, title and tax year together; "Department of the
 *    Treasury—Internal Revenue Service" on every copy;
 *  - the copy legends in the IRS wording; on Copy B boxes 1 and 2 outlined
 *    in a 2-point rule; all three box 13 checkboxes shown;
 *  - more than four box 12 codes allowed on employee copies; box 14a items
 *    labelled; state and local rows at the bottom;
 *  - SSN truncated on employee copies (allowed: 2026 General Instructions
 *    for Forms W-2 and W-3);
 *  - each copy between 2.67" × 4.25" and 6.50" × 8.50".
 */

export const BLACK = '#000000';
export const GREY = '#4D4D4D';

export const W2_TITLE = 'Wage and Tax Statement';
export const W2_OMB = 'OMB No. 1545-0029';
export const TREASURY = 'Department of the Treasury—Internal Revenue Service';

export type W2Copy = 'A' | 'B' | 'C' | 'D' | '2';

export const W2_COPY_LEGEND: Record<W2Copy, string> = {
  A: 'Copy A—For Social Security Administration. File electronically (EFW2); this printout is for your records.',
  B: "Copy B, To Be Filed With Employee's FEDERAL Tax Return.",
  C: "Copy C, For EMPLOYEE'S RECORDS (See Notice to Employee.)",
  D: 'Copy D—For Employer.',
  '2': "Copy 2, To Be Filed With Employee's State, City, or Local Income Tax Return.",
};

export const IRS_FURNISHED_NOTE =
  'This information is being furnished to the Internal Revenue Service. If you are required to file a tax return, a negligence penalty or other sanction may be imposed on you if this income is taxable and you fail to report it.';

/** Box 12 codes in plain English (2026 General Instructions for Forms W-2 and W-3). */
export const BOX12_MEANING: Record<string, string> = {
  A: 'Uncollected social security or RRTA tax on tips',
  B: 'Uncollected Medicare tax on tips',
  C: 'Taxable cost of group-term life insurance over $50,000',
  D: 'Elective deferrals to a 401(k) plan',
  E: 'Elective deferrals to a 403(b) plan',
  F: 'Elective deferrals to a 408(k)(6) SEP',
  G: 'Elective and nonelective deferrals to a 457(b) plan',
  H: 'Elective deferrals to a 501(c)(18)(D) plan',
  J: 'Nontaxable sick pay',
  K: '20% excise tax on excess golden parachute payments',
  L: 'Substantiated employee business expense reimbursements',
  M: 'Uncollected social security or RRTA tax on group-term life insurance (former employees)',
  N: 'Uncollected Medicare tax on group-term life insurance (former employees)',
  P: 'Excludable moving expense reimbursements (Armed Forces)',
  Q: 'Nontaxable combat pay',
  R: 'Employer contributions to an Archer MSA',
  S: 'Salary reductions to a SIMPLE plan',
  T: 'Adoption benefits',
  V: 'Income from exercise of nonstatutory stock options',
  W: 'Employer contributions to a health savings account (including yours made through a cafeteria plan)',
  Y: 'Deferrals under a section 409A nonqualified plan',
  Z: 'Income under a section 409A nonqualified plan',
  AA: 'Designated Roth contributions to a 401(k) plan',
  BB: 'Designated Roth contributions to a 403(b) plan',
  DD: 'Cost of employer-sponsored health coverage (not taxable)',
  EE: 'Designated Roth contributions to a governmental 457(b) plan',
  FF: 'Permitted benefits under a QSEHRA',
  GG: 'Income from qualified equity grants under section 83(i)',
  HH: 'Aggregate deferrals under section 83(i) elections',
  II: 'Medicaid waiver payments excluded from gross income',
  TA: 'Employer contributions to a Trump account',
  TP: 'Total amount of qualified tips (for the tips deduction)',
  TT: 'Qualified overtime compensation (for the overtime deduction)',
};

/** Amount in a box: unitless, two decimals, blank for zero (as on the official form). */
export function boxAmount(n: number | null | undefined): string {
  if (n == null || Math.round(n * 100) === 0) return '';
  return n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

/** "XXX-XX-6789" — the truncated SSN allowed on employee copies. */
export function truncatedSsn(ssn: string): string {
  const d = ssn.replace(/\D/g, '');
  return d.length >= 4 ? `XXX-XX-${d.slice(-4)}` : ssn;
}

/* ---- Box primitives ---------------------------------------------------- */

export interface BoxOpts {
  bold?: boolean;
  align?: 'left' | 'right';
  valueSize?: number;
  labelSize?: number;
}

/** One form box: a ruled rectangle, a small caption top-left, the value below. */
export function formBox(k: Kit, x: number, y: number, w: number, h: number, label: string, value: string | string[], o: BoxOpts = {}): void {
  const doc = k.doc;
  doc.save().lineWidth(o.bold ? 2 : 0.5).strokeColor(BLACK).rect(x, y, w, h).stroke().restore();
  const ls = o.labelSize ?? 6;
  if (label) k.text(label, x + 3, y + 2.5, { size: ls, color: GREY, width: w - 6 });
  const vs = o.valueSize ?? 9.5;
  const lines = Array.isArray(value) ? value : [value];
  let vy = y + ls + 4;
  for (const l of lines) {
    if (vy + vs * 0.72 > y + h) break;
    k.text(l, x + 4, vy, { size: vs, color: BLACK, width: w - 8, align: o.align ?? 'left' });
    vy += vs + 2;
  }
}

export function checkbox(k: Kit, x: number, y: number, label: string, checked: boolean, size = 6): number {
  const doc = k.doc;
  const s = size + 1;
  doc.save().lineWidth(0.6).strokeColor(BLACK).rect(x, y, s, s).stroke().restore();
  if (checked) {
    doc.save().lineWidth(1).strokeColor(BLACK).moveTo(x + 1.2, y + s * 0.55).lineTo(x + s * 0.42, y + s - 1.2).lineTo(x + s - 1, y + 1).stroke().restore();
  }
  k.text(label, x + s + 3, y + 0.5, { size, color: BLACK });
  return x + s + 3 + k.measure(label, { size }) + 8;
}

/* ---- The W-2 copy ------------------------------------------------------ */

export interface W2CopyData {
  taxYear: number;
  employer: { ein: string; name: string; addressLine1: string | null; addressLine2: string | null; city: string | null; state: string | null; zip: string | null };
  employee: { ssn: string; firstName: string; lastName: string; addressLine1: string | null; addressLine2: string | null; city: string | null; state: string | null; zip: string | null };
  controlNumber?: string | null;
  boxes: W2Boxes;
}

interface Row {
  state: string;
  stateId: string;
  stateWages: number;
  stateTax: number;
  localWages: number;
  localTax: number;
  locality: string;
}

/** Pair each state line with its localities: one row per state, then one row per extra locality. */
export function stateLocalRows(b: W2Boxes): Row[] {
  const rows: Row[] = [];
  const locals = [...(b.localLines ?? [])];
  for (const s of b.stateLines ?? []) {
    const mine = locals.filter((l) => (l.state ?? s.state) === s.state);
    const sid = (s as unknown as { employerStateId?: string | null }).employerStateId ?? '';
    if (!mine.length) rows.push({ state: s.state, stateId: sid, stateWages: s.stateWages, stateTax: s.stateIncomeTax, localWages: 0, localTax: 0, locality: '' });
    mine.forEach((l, i) => {
      rows.push({
        state: s.state,
        stateId: i === 0 ? sid : '',
        stateWages: i === 0 ? s.stateWages : 0,
        stateTax: i === 0 ? s.stateIncomeTax : 0,
        localWages: l.localWages,
        localTax: l.localIncomeTax,
        locality: l.locality,
      });
      locals.splice(locals.indexOf(l), 1);
    });
  }
  for (const l of locals) {
    rows.push({ state: l.state ?? '', stateId: '', stateWages: 0, stateTax: 0, localWages: l.localWages, localTax: l.localIncomeTax, locality: l.locality });
  }
  return rows;
}

/** Everything a copy must list beyond boxes 1–6, so a copy that can't hold it all continues on another. */
export function w2Overflow(b: W2Boxes, maxBox12: number, maxRows: number): { box12: W2Boxes['box12']; rows: Row[]; more: boolean } {
  const codes = b.box12 ?? [];
  const rows = stateLocalRows(b);
  return { box12: codes.slice(0, maxBox12), rows: rows.slice(0, maxRows), more: codes.length > maxBox12 || rows.length > maxRows };
}

/**
 * Draw one W-2 copy in the horizontal format (7.5" wide), the way the
 * official form is laid out. Returns the height used. `part` > 1 draws a
 * continuation copy that carries only the box 12 codes and state/local
 * rows the first could not hold.
 */
export function drawW2Copy(k: Kit, x: number, y: number, d: W2CopyData, copy: W2Copy, part: { box12: NonNullable<W2Boxes['box12']>; rows: Row[]; continuation: boolean }): number {
  const W = 540;
  const L = W * 0.5;
  const R = W - L;
  const b = d.boxes;
  const doc = k.doc;
  const employeeCopy = copy === 'B' || copy === 'C' || copy === '2';
  const ssn = employeeCopy ? truncatedSsn(d.employee.ssn) : d.employee.ssn;
  const cont = part.continuation;
  let ly = y;
  let ry = y;
  const h1 = 26;

  // Left: identifying boxes.
  formBox(k, x, ly, L * 0.55, h1, "a  Employee's social security number", ssn);
  formBox(k, x + L * 0.55, ly, L * 0.45, h1, 'd  Control number', d.controlNumber ?? '');
  ly += h1;
  formBox(k, x, ly, L, h1, 'b  Employer identification number (EIN)', fmt.ein(d.employer.ein));
  ly += h1;
  const er = d.employer;
  formBox(k, x, ly, L, 54, "c  Employer's name, address, and ZIP code", [er.name, er.addressLine1, er.addressLine2, [[er.city, er.state].filter(Boolean).join(', '), er.zip].filter(Boolean).join(' ')].filter((s): s is string => !!s), { valueSize: 8.5 });
  ly += 54;
  const ee = d.employee;
  formBox(k, x, ly, L, 26, "e  Employee's first name and initial      Last name", `${ee.firstName} ${ee.lastName}`.trim());
  ly += 26;
  formBox(k, x, ly, L, 42, "f  Employee's address and ZIP code", [ee.addressLine1, ee.addressLine2, [[ee.city, ee.state].filter(Boolean).join(', '), ee.zip].filter(Boolean).join(' ')].filter((s): s is string => !!s), { valueSize: 8.5 });
  ly += 42;

  // Right: core boxes 1–6, then 7–14.
  const rx = x + L;
  const cw = R / 2;
  const core: Array<[string, number | undefined, string, number | undefined]> = [
    ['1  Wages, tips, other compensation', b.box1Wages, '2  Federal income tax withheld', b.box2FitWithheld],
    ['3  Social security wages', b.box3SsWages, '4  Social security tax withheld', b.box4SsTax],
    ['5  Medicare wages and tips', b.box5MedicareWages, '6  Medicare tax withheld', b.box6MedicareTax],
  ];
  core.forEach(([l1, v1, l2, v2], i) => {
    const bold = copy === 'B' && i === 0 && !cont;
    formBox(k, rx, ry, cw, h1, l1, cont ? '' : boxAmount(v1), { align: 'right', bold });
    formBox(k, rx + cw, ry, cw, h1, l2, cont ? '' : boxAmount(v2), { align: 'right', bold });
    ry += h1;
  });
  formBox(k, rx, ry, cw, 22, '7  Social security tips', cont ? '' : boxAmount(b.box7SsTips), { align: 'right' });
  formBox(k, rx + cw, ry, cw, 22, '8  Allocated tips', '', { align: 'right' });
  ry += 22;
  formBox(k, rx, ry, cw, 22, '9', '', {});
  formBox(k, rx + cw, ry, cw, 22, '10  Dependent care benefits', cont ? '' : boxAmount(b.box10DependentCare), { align: 'right' });
  ry += 22;
  formBox(k, rx, ry, cw, 22, '11  Nonqualified plans', '', { align: 'right' });
  // Box 13: all three checkboxes, always.
  doc.save().lineWidth(0.5).strokeColor(BLACK).rect(rx + cw, ry, cw, 22).stroke().restore();
  k.text('13', rx + cw + 3, ry + 2.5, { size: 6, color: GREY });
  const cx = checkbox(k, rx + cw + 14, ry + 3, 'Statutory employee', false, 5);
  checkbox(k, cx, ry + 3, 'Retirement plan', !cont && !!b.box13RetirementPlan, 5);
  checkbox(k, rx + cw + 14, ry + 12.5, 'Third-party sick pay', !cont && !!b.box13ThirdPartySickPay, 5);
  ry += 22;

  // Box 12: as many codes as there are (employee copies may carry more than four).
  const codes = part.box12;
  const slots = Math.max(4, codes.length + (codes.length % 2));
  const letters = 'abcdefghijklmnopqrstuvwxyz';
  for (let i = 0; i < slots; i += 2) {
    for (let j = 0; j < 2; j++) {
      const n = i + j;
      const c = codes[n];
      const label = n === 0 ? '12a  See instructions for box 12' : `12${letters[n] ?? n}`;
      formBox(k, rx + j * cw, ry, cw, 20, label, c ? `${c.code}   ${boxAmount(c.amount)}` : '', { valueSize: 9 });
    }
    ry += 20;
  }

  // Box 14a items, labelled; 14b tipped occupation codes.
  const other = cont ? [] : (b.box14Other ?? []).map((o) => `${o.label}  ${boxAmount(o.amount)}`);
  const h14 = Math.max(22, 13 + other.length * 9.5);
  const y14 = Math.max(ly, ry);
  formBox(k, x, y14, L, h14, '14a  Other', other, { valueSize: 8 });
  formBox(k, rx, y14, R, h14, '14b  Treasury tipped occupation code', cont ? '' : (b.box14bTippedOccupationCodes ?? []).join('    '), { valueSize: 9 });
  let by = y14 + h14;

  // Boxes 15–20: one row per state / locality.
  const cols = [
    { w: 0.07, label: '15  State' },
    { w: 0.18, label: "Employer's state ID number" },
    { w: 0.14, label: '16  State wages, tips, etc.' },
    { w: 0.13, label: '17  State income tax' },
    { w: 0.14, label: '18  Local wages, tips, etc.' },
    { w: 0.13, label: '19  Local income tax' },
    { w: 0.21, label: '20  Locality name' },
  ];
  const rows = part.rows.length ? part.rows : [{ state: '', stateId: '', stateWages: 0, stateTax: 0, localWages: 0, localTax: 0, locality: '' }];
  rows.forEach((r, ri) => {
    let px = x;
    const vals = [r.state, r.stateId, boxAmount(r.stateWages), boxAmount(r.stateTax), boxAmount(r.localWages), boxAmount(r.localTax), r.locality];
    cols.forEach((c, ci) => {
      const cwid = W * c.w;
      formBox(k, px, by, cwid, 22, ri === 0 ? c.label : '', vals[ci], { align: ci >= 2 && ci <= 5 ? 'right' : 'left', valueSize: 8.5, labelSize: 5.5 });
      px += cwid;
    });
    by += 22;
  });

  // The form's identity line and the copy legend.
  by += 5;
  k.text('Form', x, by + 4, { size: 7, color: BLACK });
  k.text('W-2', x + 18, by, { size: 15, weight: 'bold', color: BLACK });
  k.text(W2_TITLE, x + 50, by + 3.5, { size: 9.5, weight: 'semibold', color: BLACK });
  k.text(String(d.taxYear), x + W / 2 - 22, by - 1, { size: 17, weight: 'bold', color: BLACK });
  k.text(TREASURY, x + W - 230, by + 1, { size: 6.5, color: BLACK, width: 230, align: 'right' });
  k.text(W2_OMB, x + W - 230, by + 9.5, { size: 6, color: GREY, width: 230, align: 'right' });
  by += 20;
  k.text(cont ? `${W2_COPY_LEGEND[copy]}  Continued: additional box 12, state and local entries.` : W2_COPY_LEGEND[copy], x, by, { size: 7, weight: 'semibold', color: BLACK, width: W });
  by += 10;
  if (copy === 'B' || copy === 'C') {
    const h = k.para(IRS_FURNISHED_NOTE, x, by, W, { size: 6.5, color: BLACK });
    by += h;
  }
  return by - y + 2;
}

/** Height a copy will take, for laying copies out without drawing. */
export function w2CopyHeight(b: W2Boxes, part: { box12: NonNullable<W2Boxes['box12']>; rows: Row[]; continuation: boolean }, copy: W2Copy): number {
  const left = 26 * 2 + 54 + 26 + 42;
  const slots = Math.max(4, part.box12.length + (part.box12.length % 2));
  const right = 26 * 3 + 22 * 3 + (slots / 2) * 20;
  const other = part.continuation ? 0 : (b.box14Other ?? []).length;
  const h14 = Math.max(22, 13 + other * 9.5);
  const rows = Math.max(1, part.rows.length);
  return Math.max(left, right) + h14 + rows * 22 + 5 + 20 + 10 + (copy === 'B' || copy === 'C' ? 20 : 0) + 2;
}

/** Split a W-2 into copy parts so no copy is taller than 6.5" (468pt). */
export function w2Parts(b: W2Boxes, copy: W2Copy): Array<{ box12: NonNullable<W2Boxes['box12']>; rows: Row[]; continuation: boolean }> {
  const codes = b.box12 ?? [];
  const rows = stateLocalRows(b);
  const parts: Array<{ box12: NonNullable<W2Boxes['box12']>; rows: Row[]; continuation: boolean }> = [];
  let ci = 0;
  let ri = 0;
  let first = true;
  do {
    let nCodes = Math.min(codes.length - ci, 8);
    let nRows = Math.min(rows.length - ri, 6);
    const make = () => ({ box12: codes.slice(ci, ci + nCodes), rows: rows.slice(ri, ri + nRows), continuation: !first });
    while (w2CopyHeight(b, make(), copy) > 468 && (nCodes > 4 || nRows > 1)) {
      if (nRows > 1) nRows -= 1;
      else nCodes -= 2;
    }
    parts.push(make());
    ci += nCodes;
    ri += nRows;
    first = false;
  } while (ci < codes.length || ri < rows.length);
  return parts;
}

/* ---- Notice and instructions to the employee --------------------------- */

export const W2_NOTICE_TO_EMPLOYEE: Array<{ title: string; body: string }> = [
  {
    title: 'Do you have to file?',
    body: 'Refer to the Instructions for Forms 1040 and 1040-SR to determine if you are required to file a tax return. Even if you don\'t have to file a tax return, you may be eligible for a refund if box 2 shows an amount or if you are eligible for any credit.',
  },
  {
    title: 'Earned income credit (EIC)',
    body: 'You may be able to take the EIC for this year if your adjusted gross income (AGI) is less than a certain amount. The amount of the credit is based on income and family size. Workers without children could qualify for a smaller credit. You and any qualifying children must have valid social security numbers (SSNs). You can\'t take the EIC if your investment income is more than the specified amount for the year or if income is earned for services provided while you were an inmate at a penal institution. For income limits and more information, visit www.irs.gov/EITC. See also Pub. 596. Any EIC that is more than your tax liability is refunded to you, but only if you file a tax return.',
  },
  {
    title: 'Employee\'s social security number (SSN)',
    body: 'For your protection, this form may show only the last four digits of your SSN. However, your employer has reported your complete SSN to the IRS and the Social Security Administration (SSA).',
  },
  {
    title: 'Clergy and religious workers',
    body: 'If you aren\'t subject to social security and Medicare taxes, see Pub. 517.',
  },
  {
    title: 'Corrections',
    body: 'If your name, SSN, or address is incorrect, correct Copies B, C, and 2 and ask your employer to correct your employment record. Be sure to ask the employer to file Form W-2c, Corrected Wage and Tax Statement, with the SSA to correct any name, SSN, or money amount error reported to the SSA on Form W-2. Be sure to get your copies of Form W-2c from your employer for all corrections made so you may file them with your tax return. If your name and SSN are correct but aren\'t the same as shown on your social security card, you should ask for a new card that displays your correct name at any SSA office or by calling 800-772-1213. You may also visit the SSA website at www.SSA.gov.',
  },
  {
    title: 'Cost of employer-sponsored health coverage',
    body: 'The reporting in box 12, using code DD, of the cost of employer-sponsored health coverage is for your information only. The amount reported with code DD is not taxable.',
  },
  {
    title: 'Credit for excess taxes',
    body: 'If you had more than one employer this year and more than the maximum social security tax was withheld, you may be able to claim a credit for the excess against your federal income tax. If you had more than one railroad employer and more than the maximum Tier 1 RRTA tax was withheld, you may be able to claim a credit. See the Instructions for Forms 1040 and 1040-SR and Pub. 505.',
  },
];

export const W2_BOX_INSTRUCTIONS: Array<{ box: string; body: string }> = [
  { box: 'Box 1', body: 'Enter this amount on the wages line of your tax return.' },
  { box: 'Box 2', body: 'Enter this amount on the federal income tax withheld line of your tax return.' },
  { box: 'Box 5', body: 'You may be required to report this amount on Form 8959, Additional Medicare Tax. See the Instructions for Forms 1040 and 1040-SR to determine if you are required to complete Form 8959.' },
  { box: 'Box 6', body: 'This amount includes the 1.45% Medicare tax withheld on all Medicare wages and tips shown in box 5, as well as the 0.9% Additional Medicare Tax on any of those Medicare wages and tips above $200,000.' },
  { box: 'Box 8', body: 'This amount is not included in box 1, 3, 5, or 7. For information on how to report tips on your tax return, see the Instructions for Forms 1040 and 1040-SR.' },
  { box: 'Box 10', body: 'This amount includes the total dependent care benefits that your employer paid to you or incurred on your behalf (including amounts from a section 125 (cafeteria) plan). Any amount over your employer\'s plan limit is also included in box 1. See Form 2441.' },
  { box: 'Box 11', body: 'This amount is (a) reported in box 1 if it is a distribution made to you from a nonqualified deferred compensation or nongovernmental section 457(b) plan, or (b) included in box 3 and/or box 5 if it is a prior year deferral under a nonqualified or section 457(b) plan that became taxable for social security and Medicare taxes this year because there is no longer a substantial risk of forfeiture of your right to the deferred amount.' },
  { box: 'Box 12', body: 'The codes your employer used are explained on the first page of this statement; the full list is in the General Instructions for Forms W-2 and W-3 at www.irs.gov/FormW2.' },
  { box: 'Box 13', body: 'If the "Retirement plan" box is checked, special limits may apply to the amount of traditional IRA contributions you may deduct. See Pub. 590-A.' },
  { box: 'Box 14a', body: 'Employers may use this box to report information such as state disability insurance taxes withheld, union dues, uniform payments, health insurance premiums deducted, nontaxable income, educational assistance payments, or a member of the clergy\'s parsonage allowance and utilities.' },
  { box: 'Box 14b', body: 'The Treasury Tipped Occupation Code for the work that produced the tips reported in box 12, code TP.' },
];

/**
 * The vertical format for a 4-up sheet: one copy per 4.25" × 5.5" quadrant
 * (Pub 1141 §2.3 .03 permits vertical copies with the core boxes across
 * the top). Draws at the quadrant's full width so the copy is never
 * narrower than the 4.25" minimum. Returns the height used, or -1 when the
 * copy has too much to fit (the caller then uses the full-size layout).
 */
/** Height of a narrow (4-up) copy. */
export function w2NarrowHeight(b: W2Boxes, copy: W2Copy): number {
  const rh = 21;
  const codes = b.box12 ?? [];
  const other = b.box14Other ?? [];
  const rows = stateLocalRows(b);
  return rh * 3 + rh + 40 + rh + 32 + (b.box7SsTips || b.box10DependentCare ? rh : 0) + Math.ceil(codes.length / 2) * 18 + 18 + (other.length ? 12 + other.length * 8 : 0) + Math.max(1, rows.length) * 34 + 44 + (copy === 'C' || copy === 'B' ? 22 : 0);
}

export function drawW2CopyNarrow(k: Kit, x0: number, y: number, w0: number, maxH: number, d: W2CopyData, copy: W2Copy): number {
  // Inset a hair so the 2-point outline on boxes 1 and 2 stays on the page.
  const x = x0 + 1.5;
  const w = w0 - 3;
  const b = d.boxes;
  const codes = b.box12 ?? [];
  const rows = stateLocalRows(b);
  const other = (b.box14Other ?? []).map((o) => `${o.label}  ${boxAmount(o.amount)}`);
  const half = w / 2;
  const rh = 21;
  if (w2NarrowHeight(b, copy) > maxH) return -1;
  const employeeCopy = copy === 'B' || copy === 'C' || copy === '2';
  const o = { valueSize: 8.5, labelSize: 5 };
  let cy = y;
  const core: Array<[string, number | undefined, string, number | undefined]> = [
    ['1  Wages, tips, other comp.', b.box1Wages, '2  Federal income tax withheld', b.box2FitWithheld],
    ['3  Social security wages', b.box3SsWages, '4  Social security tax withheld', b.box4SsTax],
    ['5  Medicare wages and tips', b.box5MedicareWages, '6  Medicare tax withheld', b.box6MedicareTax],
  ];
  core.forEach(([l1, v1, l2, v2], i) => {
    const bold = copy === 'B' && i === 0;
    formBox(k, x, cy, half, rh, l1, boxAmount(v1), { ...o, align: 'right', bold });
    formBox(k, x + half, cy, half, rh, l2, boxAmount(v2), { ...o, align: 'right', bold });
    cy += rh;
  });
  formBox(k, x, cy, half, rh, "a  Employee's SSN", employeeCopy ? truncatedSsn(d.employee.ssn) : d.employee.ssn, o);
  formBox(k, x + half, cy, half, rh, 'b  Employer ID number (EIN)', fmt.ein(d.employer.ein), o);
  cy += rh;
  const er = d.employer;
  formBox(k, x, cy, w, 40, "c  Employer's name, address, and ZIP code", [er.name, [er.addressLine1, er.addressLine2].filter(Boolean).join(', '), [[er.city, er.state].filter(Boolean).join(', '), er.zip].filter(Boolean).join(' ')].filter((s2): s2 is string => !!s2), { valueSize: 7.5, labelSize: 5 });
  cy += 40;
  const ee = d.employee;
  formBox(k, x, cy, w, rh, "e  Employee's name", `${ee.firstName} ${ee.lastName}`.trim(), o);
  cy += rh;
  formBox(k, x, cy, w, 32, "f  Employee's address and ZIP code", [[ee.addressLine1, ee.addressLine2].filter(Boolean).join(', '), [[ee.city, ee.state].filter(Boolean).join(', '), ee.zip].filter(Boolean).join(' ')].filter((s2): s2 is string => !!s2), { valueSize: 7.5, labelSize: 5 });
  cy += 32;
  if (b.box7SsTips || b.box10DependentCare) {
    formBox(k, x, cy, half, rh, '7  Social security tips', boxAmount(b.box7SsTips), { ...o, align: 'right' });
    formBox(k, x + half, cy, half, rh, '10  Dependent care benefits', boxAmount(b.box10DependentCare), { ...o, align: 'right' });
    cy += rh;
  }
  const letters = 'abcdefghijklmnopqrstuvwxyz';
  for (let i = 0; i < codes.length; i += 2) {
    for (let j = 0; j < 2; j++) {
      const c = codes[i + j];
      if (!c) continue;
      formBox(k, x + j * half, cy, half, 18, `12${letters[i + j]}`, `${c.code}   ${boxAmount(c.amount)}`, { valueSize: 8, labelSize: 5 });
    }
    cy += 18;
  }
  k.doc.save().lineWidth(0.5).strokeColor(BLACK).rect(x, cy, w, 18).stroke().restore();
  k.text('13', x + 3, cy + 2, { size: 5, color: GREY });
  let bx = x + 14;
  bx = checkbox(k, bx, cy + 5, 'Statutory employee', false, 5);
  bx = checkbox(k, bx, cy + 5, 'Retirement plan', !!b.box13RetirementPlan, 5);
  checkbox(k, bx, cy + 5, 'Third-party sick pay', !!b.box13ThirdPartySickPay, 5);
  cy += 18;
  if (other.length) {
    formBox(k, x, cy, w, 12 + other.length * 8, '14a  Other', other, { valueSize: 6.5, labelSize: 5 });
    cy += 12 + other.length * 8;
  }
  for (const r of rows.length ? rows : [{ state: '', stateId: '', stateWages: 0, stateTax: 0, localWages: 0, localTax: 0, locality: '' }]) {
    const t = w / 3;
    formBox(k, x, cy, t, 17, '15  State / employer state ID', [r.state, r.stateId].filter(Boolean).join('  '), { valueSize: 7, labelSize: 4.5 });
    formBox(k, x + t, cy, t, 17, '16  State wages, tips, etc.', boxAmount(r.stateWages), { valueSize: 7, labelSize: 4.5, align: 'right' });
    formBox(k, x + 2 * t, cy, t, 17, '17  State income tax', boxAmount(r.stateTax), { valueSize: 7, labelSize: 4.5, align: 'right' });
    formBox(k, x, cy + 17, t, 17, '18  Local wages, tips, etc.', boxAmount(r.localWages), { valueSize: 7, labelSize: 4.5, align: 'right' });
    formBox(k, x + t, cy + 17, t, 17, '19  Local income tax', boxAmount(r.localTax), { valueSize: 7, labelSize: 4.5, align: 'right' });
    formBox(k, x + 2 * t, cy + 17, t, 17, '20  Locality name', r.locality, { valueSize: 7, labelSize: 4.5 });
    cy += 34;
  }
  cy += 5;
  k.text('Form', x + 3, cy + 3, { size: 5.5, color: BLACK });
  k.text('W-2', x + 17, cy, { size: 11, weight: 'bold', color: BLACK });
  k.text(W2_TITLE, x + 42, cy + 2, { size: 7, weight: 'semibold', color: BLACK });
  k.text(String(d.taxYear), x + w - 40, cy - 1, { size: 12, weight: 'bold', color: BLACK, width: 37, align: 'right' });
  cy += 15;
  k.text(TREASURY, x + 3, cy, { size: 5, color: BLACK, width: w - 6 });
  k.text(W2_OMB, x + 3, cy, { size: 5, color: GREY, width: w - 6, align: 'right' });
  cy += 8;
  k.text(W2_COPY_LEGEND[copy], x + 3, cy, { size: 5.5, weight: 'semibold', color: BLACK, width: w - 6 });
  cy += 8;
  if (copy === 'B' || copy === 'C') cy += k.para(IRS_FURNISHED_NOTE, x + 3, cy, w - 6, { size: 4.6, color: BLACK });
  return cy - y;
}

/* ---- Form 1099 copies (IRS Pub 1179 substitute recipient statements) ---- */

export const F1099_IMPORTANT =
  'This is important tax information and is being furnished to the IRS. If you are required to file a return, a negligence penalty or other sanction may be imposed on you if this income is taxable and the IRS determines that it has not been reported.';

export type F1099Copy = 'A' | '1' | 'B' | '2' | 'C';
export const F1099_LEGEND: Record<F1099Copy, string> = {
  A: 'Copy A—For Internal Revenue Service Center. File electronically (IRIS/FIRE); this printout is for your records.',
  '1': 'Copy 1—For State Tax Department.',
  B: 'Copy B—For Recipient.',
  '2': "Copy 2—To be filed with recipient's state income tax return, when required.",
  C: "Copy C—For Payer's records.",
};

export interface F1099Party {
  name: string;
  addressLine1: string | null;
  addressLine2: string | null;
  city: string | null;
  state: string | null;
  zip: string | null;
  phone?: string | null;
}

export interface F1099CopySpec {
  formNumber: string; // "1099-NEC"
  title: string; // "Nonemployee Compensation"
  omb: string;
  taxYear: number;
  payer: F1099Party & { ein: string };
  recipient: F1099Party & { tin: string };
  accountNumber: string;
  /** The money boxes in form order: [label, value]; a boolean box renders as a checkbox. */
  boxes: Array<{ label: string; value: number | boolean | null }>;
  /** State rows: [state tax withheld, state/payer's state no., state income] with the box numbers to print. */
  stateBoxes: { tax: string; id: string; income: string };
  stateRows: Array<{ tax: number; state: string; income: number }>;
}

/** Mask a recipient TIN to the last four (allowed on recipient copies). */
export function truncatedTin(tin: string): string {
  const d = tin.replace(/\D/g, '');
  if (d.length < 4) return tin;
  return d.length === 9 && /^\d{2}-/.test(tin) ? `XX-XXX${d.slice(-4)}` : `XXX-XX-${d.slice(-4)}`;
}

/** One 1099 copy, 7.5" wide in the official left-identity / right-boxes layout. Returns the height used. */
export function draw1099Copy(k: Kit, x: number, y: number, s: F1099CopySpec, copy: F1099Copy): number {
  const W = 540;
  const L = W * 0.48;
  const R = W - L;
  const recipientCopy = copy === 'B' || copy === '2';
  const p = s.payer;
  const r = s.recipient;
  const addr = (a: F1099Party) => [a.name, a.addressLine1, a.addressLine2, [[a.city, a.state].filter(Boolean).join(', '), a.zip].filter(Boolean).join(' ')].filter((v): v is string => !!v);
  let ly = y;
  formBox(k, x, ly, L, 66, "PAYER'S name, street address, city or town, state or province, country, ZIP or foreign postal code, and telephone no.", [...addr(p), ...(p.phone ? [p.phone] : [])], { valueSize: 8, labelSize: 5 });
  ly += 66;
  formBox(k, x, ly, L / 2, 26, "PAYER'S TIN", fmt.ein(p.ein));
  formBox(k, x + L / 2, ly, L / 2, 26, "RECIPIENT'S TIN", recipientCopy ? truncatedTin(r.tin) : r.tin);
  ly += 26;
  formBox(k, x, ly, L, 24, "RECIPIENT'S name", r.name);
  ly += 24;
  formBox(k, x, ly, L, 22, 'Street address (including apt. no.)', [r.addressLine1, r.addressLine2].filter(Boolean).join(', '), { valueSize: 8.5 });
  ly += 22;
  formBox(k, x, ly, L, 22, 'City or town, state or province, country, and ZIP or foreign postal code', [[r.city, r.state].filter(Boolean).join(', '), r.zip].filter(Boolean).join(' '), { valueSize: 8.5, labelSize: 5 });
  ly += 22;
  formBox(k, x, ly, L, 22, 'Account number (see instructions)', s.accountNumber, { valueSize: 8.5 });
  ly += 22;

  // Right: the title block, then the boxes two to a row.
  const rx = x + L;
  let ry = y;
  k.doc.save().lineWidth(0.5).strokeColor(BLACK).rect(rx, ry, R, 40).stroke().restore();
  k.text(s.omb, rx + 6, ry + 4, { size: 6, color: GREY });
  k.text('Form', rx + 6, ry + 17, { size: 6.5, color: BLACK });
  k.text(s.formNumber, rx + 24, ry + 12, { size: 14, weight: 'bold', color: BLACK });
  k.text(s.title, rx + 6, ry + 29, { size: 8.5, weight: 'semibold', color: BLACK, width: R / 2 });
  k.text(`For calendar year ${s.taxYear}`, rx + R / 2, ry + 6, { size: 6.5, color: GREY, width: R / 2 - 6, align: 'right' });
  k.text(String(s.taxYear), rx + R / 2, ry + 15, { size: 16, weight: 'bold', color: BLACK, width: R / 2 - 6, align: 'right' });
  ry += 40;
  const cw = R / 2;
  for (let i = 0; i < s.boxes.length; i += 2) {
    for (let j = 0; j < 2; j++) {
      const b = s.boxes[i + j];
      if (!b) continue;
      const bx = rx + j * cw;
      if (typeof b.value === 'boolean') {
        k.doc.save().lineWidth(0.5).strokeColor(BLACK).rect(bx, ry, cw, 26).stroke().restore();
        k.text(b.label, bx + 3, ry + 2.5, { size: 5.5, color: GREY, width: cw - 18 });
        checkbox(k, bx + cw - 14, ry + 12, '', b.value, 6);
      } else {
        formBox(k, bx, ry, cw, 26, b.label, b.value == null || !boxAmount(b.value) ? '' : `$ ${boxAmount(b.value)}`, { align: 'right', labelSize: 5.5 });
      }
    }
    ry += 26;
  }
  let by = Math.max(ly, ry);
  const rows = s.stateRows.length ? s.stateRows : [{ tax: 0, state: '', income: 0 }];
  rows.slice(0, 4).forEach((row, i) => {
    const w3 = W / 3;
    formBox(k, x, by, w3, 22, i === 0 ? s.stateBoxes.tax : '', boxAmount(row.tax) ? `$ ${boxAmount(row.tax)}` : '', { align: 'right', labelSize: 5.5 });
    formBox(k, x + w3, by, w3, 22, i === 0 ? s.stateBoxes.id : '', row.state, { labelSize: 5.5 });
    formBox(k, x + 2 * w3, by, w3, 22, i === 0 ? s.stateBoxes.income : '', boxAmount(row.income) ? `$ ${boxAmount(row.income)}` : '', { align: 'right', labelSize: 5.5 });
    by += 22;
  });
  by += 5;
  k.text(`Form ${s.formNumber}`, x, by, { size: 8, weight: 'semibold', color: BLACK });
  k.text('(keep for your records)', x + 70, by + 1, { size: 6.5, color: GREY });
  k.text(TREASURY, x + W - 260, by, { size: 6.5, color: BLACK, width: 260, align: 'right' });
  by += 12;
  k.text(F1099_LEGEND[copy], x, by, { size: 7, weight: 'semibold', color: BLACK, width: W });
  by += 10;
  if (recipientCopy) by += k.para(F1099_IMPORTANT, x, by, W, { size: 6.5, color: BLACK });
  return by - y + 2;
}

/**
 * A recipient's 1099 statement: a short cover in the house style with the
 * amounts in plain English, Copy B and Copy 2 (black ink, compliant), and
 * the instructions for the recipient. A single other copy (A, 1, C)
 * renders just that copy.
 */
export async function render1099Statement(o: {
  spec: F1099CopySpec;
  copy: F1099Copy;
  meta: { formId: string; generatedAt: string };
  summary: Array<{ label: string; amount: number }>;
  instructions: Array<{ title: string; body: string }>;
}): Promise<Buffer> {
  const s = o.spec;
  const { k } = createDoc({ title: `Form ${s.formNumber} ${s.taxYear} · ${s.recipient.name}`, author: s.payer.name, margin: 36, creationDate: new Date(o.meta.generatedAt) });
  const copies: F1099Copy[] = o.copy === 'B' ? ['B', '2'] : [o.copy];
  if (o.copy === 'B') {
    let y = k.masthead({
      title: `Your ${s.taxYear} Form ${s.formNumber}`,
      subtitle: s.title,
      brand: { name: s.payer.name, lines: [[s.payer.addressLine1, [[s.payer.city, s.payer.state].filter(Boolean).join(', '), s.payer.zip].filter(Boolean).join(' ')].filter(Boolean).join(', '), `TIN ${fmt.ein(s.payer.ein)}`].filter(Boolean) },
    });
    y += k.para(`${s.recipient.name}, this is your Form ${s.formNumber} for ${s.taxYear}: what ${s.payer.name} paid you as a non-employee and reported to the IRS. Report this income on your tax return; the official copies follow.`, k.L, y, k.width(), { size: SIZE.body, color: COLOR.ink2 }) + 12;
    y = k.figures(o.summary.slice(0, 4).map((m) => ({ label: m.label, value: fmt.money(m.amount) })), y);
    y = k.section('What to do with each copy', y);
    for (const [c, t] of [['Copy B', 'Keep it and use the amounts on your tax return (Schedule C or Schedule 1, depending on the kind of income).'], ['Copy 2', 'File with your state income tax return when your state requires it.']] as Array<[string, string]>) {
      k.text(c, k.L, y, { size: SIZE.body, weight: 'semibold', width: 70 });
      const h = k.para(t, k.L + 70, y, k.width() - 70, { size: SIZE.body, color: COLOR.ink2 });
      y += Math.max(15, h + 4);
    }
    k.callout({ tone: 'info', title: 'Something looks wrong?', body: `If your name, TIN or an amount is wrong, contact ${s.payer.name}. They will file a corrected form with the IRS and send you a copy. For your protection the copies show only the last four digits of your TIN.` }, y + 8);
    k.doc.addPage();
  }
  let y = 36;
  copies.forEach((c, i) => {
    if (i > 0) {
      k.doc.save().lineWidth(0.5).dash(3, { space: 3 }).strokeColor(GREY).moveTo(36, y + 6).lineTo(576, y + 6).stroke().undash().restore();
      k.text('Cut along the dotted line', 36, y + 9, { size: 5.5, color: GREY });
      y += 18;
    }
    y += draw1099Copy(k, 36, y, s, c);
  });
  if (o.copy === 'B' || o.copy === '2') {
    k.doc.addPage();
    let iy = k.top;
    k.text(`Instructions for Recipient · Form ${s.formNumber}`, k.L, iy, { size: SIZE.heading, family: 'display', weight: 'semibold', color: BLACK });
    iy += 26;
    for (const n of o.instructions) {
      const h = k.para(n.body, 0, 0, k.width(), { size: 7.5 }, false) + 16;
      if (iy + h > k.bottom()) {
        k.doc.addPage();
        iy = k.top;
      }
      k.text(n.title, k.L, iy, { size: 8, weight: 'semibold', color: BLACK });
      iy += 11;
      iy += k.para(n.body, k.L, iy, k.width(), { size: 7.5, color: BLACK }) + 6;
    }
  }
  return k.finish({ reference: `Form ${s.formNumber} ${s.taxYear} · ${o.meta.formId.slice(0, 8)}`, note: s.payer.name });
}

export const F1099_COMMON_INSTRUCTIONS: Array<{ title: string; body: string }> = [
  { title: "Recipient's taxpayer identification number (TIN)", body: 'For your protection, this form may show only the last four digits of your TIN (social security number (SSN), individual taxpayer identification number (ITIN), adoption taxpayer identification number (ATIN), or employer identification number (EIN)). However, the issuer has reported your complete TIN to the IRS.' },
  { title: 'Account number', body: 'May show an account or other unique number the payer assigned to distinguish your account.' },
  { title: 'Future developments', body: 'For the latest information about developments related to Forms 1099 and their instructions, such as legislation enacted after they were published, go to www.irs.gov/Form1099.' },
  { title: 'Free File Program', body: 'Go to www.irs.gov/FreeFile to see if you qualify for no-cost online federal tax preparation, e-filing, and direct deposit or payment options.' },
];
