// Gap 1 — EFW2C e-file generator (SSA Pub 42-014).
//
// Sister format to EFW2 — used to electronically file W-2c corrections.
// Same 512-char fixed-width record discipline; record types prefixed
// with "RC" instead of "R":
//
//   RCA  Submitter   — one per file, first record
//   RCE  Employer    — one per Employer-EIN block
//   RCW  Employee    — one per W-2c, carries previous + corrected for
//                      every box (~ twice the field count of an RW)
//   RCS  State       — one per state line per RCW (Box 15-17 prev/curr)
//   RCT  Totals      — closes the RCE block, sums RCW dollar fields
//   RCF  Final       — one per file, last record, total RCW count
//
// =============================================================================
// !!  IMPORTANT  !!
// Field positions below are written from spec memory. Like EFW2, they
// MUST be cross-checked against SSA Pub 42-014 + the AccuWage Online
// W-2c validator before any production BSO upload. Until that pass is
// done, treat output as a draft, not a filing-ready file.
// =============================================================================

import type { W2Boxes } from './w2Aggregator.js';

const RECORD_LEN = 512;

export interface Efw2cSubmitter {
  ein: string;
  userId: string;
  name: string;
  addressLine1: string;
  addressLine2?: string | null;
  city: string;
  state: string;
  zip5: string;
  zip4?: string | null;
  contactName: string;
  contactPhone: string;
  contactEmail: string;
}

export interface Efw2cEmployer {
  ein: string;
  taxYear: number;
  name: string;
  addressLine1: string;
  addressLine2?: string | null;
  city: string;
  state: string;
  zip5: string;
  zip4?: string | null;
}

export interface Efw2cEmployee {
  ssn: string;
  firstName: string;
  middleName?: string | null;
  lastName: string;
  suffix?: string | null;
  addressLine1: string;
  addressLine2?: string | null;
  city: string;
  state: string;
  zip5: string;
  zip4?: string | null;
  /** Box totals as previously reported on the original W-2. */
  previous: W2Boxes;
  /** Corrected box totals as they should now read. */
  corrected: W2Boxes;
}

export interface Efw2cFile {
  submitter: Efw2cSubmitter;
  employer: Efw2cEmployer;
  employees: Efw2cEmployee[];
}

export function buildEfw2cFile(input: Efw2cFile): string {
  const records: string[] = [];

  records.push(buildRCA(input.submitter));
  records.push(buildRCE(input.employer));

  const totals = newRctTotals();

  for (const e of input.employees) {
    records.push(buildRCW(e));
    totals.rcwCount += 1;
    totals.deltaBox1 += e.corrected.box1Wages - e.previous.box1Wages;
    totals.deltaBox2 += e.corrected.box2FitWithheld - e.previous.box2FitWithheld;
    totals.deltaBox3 += e.corrected.box3SsWages - e.previous.box3SsWages;
    totals.deltaBox4 += e.corrected.box4SsTax - e.previous.box4SsTax;
    totals.deltaBox5 += e.corrected.box5MedicareWages - e.previous.box5MedicareWages;
    totals.deltaBox6 += e.corrected.box6MedicareTax - e.previous.box6MedicareTax;

    // RCS state records — one per state appearing in either prev or curr.
    const stateUnion = new Set<string>();
    for (const s of e.previous.stateLines) stateUnion.add(s.state);
    for (const s of e.corrected.stateLines) stateUnion.add(s.state);
    for (const state of [...stateUnion].sort()) {
      records.push(buildRCS(e, state));
    }
  }

  records.push(buildRCT(totals));
  records.push(buildRCF({ rcwCount: totals.rcwCount }));

  return records.join('\r\n');
}

// ---- Record builders -----------------------------------------------------

function buildRCA(s: Efw2cSubmitter): string {
  // RCA SUBMITTER RECORD — same field semantics as RA. We use the same
  // positions as buildRA in efw2.ts so the two record types stay
  // structurally aligned in case finance compares them.
  const fields: Field[] = [
    fixed('RCA', 1, 3),
    digits(s.ein, 4, 12),
    text(s.userId, 13, 29),
    blank(30, 31),
    digits('0', 32, 33), // Resub Indicator: 0 = original
    blank(34, 39),
    digits('99', 40, 47), // Software Code: 99 = vendor
    text(s.name, 48, 104),
    text(s.addressLine1, 105, 126),
    text(s.addressLine2 ?? '', 127, 148),
    text(s.city, 149, 170),
    text(s.state, 171, 172),
    digits(s.zip5, 173, 177),
    text(s.zip4 ?? '', 178, 181),
    blank(182, 200),
    blank(201, 202),
    text(s.contactName, 203, 259),
    text(stripPhone(s.contactPhone), 260, 274),
    blank(275, 279),
    text(s.contactEmail, 280, 319),
    blank(320, 323),
    blank(324, 333),
    fixed('S', 334, 334),
    blank(335, 512),
  ];
  return assemble(fields);
}

function buildRCE(e: Efw2cEmployer): string {
  // RCE EMPLOYER RECORD. Mirrors RE structure. Tax year identifies the
  // calendar year of the W-2cs that follow.
  const fields: Field[] = [
    fixed('RCE', 1, 3),
    digits(String(e.taxYear), 4, 7),
    blank(8, 8),
    digits(e.ein, 9, 17),
    blank(18, 26),
    fixed('R', 27, 27), // Terminating business: R = none
    blank(28, 30),
    blank(31, 39),
    text(e.name, 40, 96),
    blank(97, 118),
    text(e.addressLine1, 119, 140),
    text(e.city, 141, 162),
    text(e.state, 163, 164),
    digits(e.zip5, 165, 169),
    text(e.zip4 ?? '', 170, 173),
    blank(174, 175),
    blank(176, 179),
    blank(180, 194),
    blank(195, 196),
    fixed('R', 197, 197), // Employment code: R = regular
    blank(198, 198),
    fixed('N', 199, 199), // Third-Party Sick Pay: N = no
    blank(200, 512),
  ];
  return assemble(fields);
}

function buildRCW(emp: Efw2cEmployee): string {
  // RCW EMPLOYEE WAGE RECORD. The big difference from RW: every dollar
  // box appears twice — "Originally Reported" and "Correct" — with the
  // pair adjacent. The IRS validator matches against the originals to
  // identify what changed.
  const fields: Field[] = [
    fixed('RCW', 1, 3),
    digits(emp.ssn, 4, 12),
    text(emp.firstName, 13, 27),
    text(emp.middleName ?? '', 28, 42),
    text(emp.lastName, 43, 62),
    text(emp.suffix ?? '', 63, 66),
    text(emp.addressLine1, 67, 88),
    text(emp.addressLine2 ?? '', 89, 110),
    text(emp.city, 111, 132),
    text(emp.state, 133, 134),
    digits(emp.zip5, 135, 139),
    text(emp.zip4 ?? '', 140, 143),
    blank(144, 167),
    // Pairs: previous, then corrected. Each is 11 digits in cents.
    money(emp.previous.box1Wages, 168, 178),
    money(emp.corrected.box1Wages, 179, 189),
    money(emp.previous.box2FitWithheld, 190, 200),
    money(emp.corrected.box2FitWithheld, 201, 211),
    money(emp.previous.box3SsWages, 212, 222),
    money(emp.corrected.box3SsWages, 223, 233),
    money(emp.previous.box4SsTax, 234, 244),
    money(emp.corrected.box4SsTax, 245, 255),
    money(emp.previous.box5MedicareWages, 256, 266),
    money(emp.corrected.box5MedicareWages, 267, 277),
    money(emp.previous.box6MedicareTax, 278, 288),
    money(emp.corrected.box6MedicareTax, 289, 299),
    // Boxes 7-11 prev/curr — zero until those features land. Twelve
    // pairs × 11 chars = 132 chars; we pack five pairs here (boxes 7-11).
    money(0, 300, 310), money(0, 311, 321), // Box 7
    money(0, 322, 332), money(0, 333, 343), // Box 8
    money(0, 344, 354), money(0, 355, 365), // Box 10 (Box 9 deprecated)
    money(0, 366, 376), money(0, 377, 387), // Box 11
    blank(388, 461),
    fixed('0', 462, 462), // Statutory employee
    fixed('0', 463, 463), // Retirement plan
    fixed('0', 464, 464), // Third-party sick pay
    blank(465, 512),
  ];
  return assemble(fields);
}

function buildRCS(emp: Efw2cEmployee, state: string): string {
  // RCS STATE RECORD — one per state per employee. Carries previous +
  // corrected wages and tax for that state. Position 4-5 is the USPS
  // letter code; same TODO as efw2.ts about FIPS-vs-USPS verification.
  const prev = emp.previous.stateLines.find((s) => s.state === state);
  const curr = emp.corrected.stateLines.find((s) => s.state === state);
  const prevWages = prev?.stateWages ?? 0;
  const prevTax = prev?.stateIncomeTax ?? 0;
  const currWages = curr?.stateWages ?? 0;
  const currTax = curr?.stateIncomeTax ?? 0;
  const fields: Field[] = [
    fixed('RCS', 1, 3),
    text(state, 4, 5),
    digits(emp.ssn, 6, 14),
    text(emp.firstName, 15, 29),
    text(emp.middleName ?? '', 30, 44),
    text(emp.lastName, 45, 64),
    text(emp.suffix ?? '', 65, 68),
    text(emp.addressLine1, 69, 90),
    text(emp.addressLine2 ?? '', 91, 112),
    text(emp.city, 113, 134),
    text(emp.state, 135, 136),
    digits(emp.zip5, 137, 141),
    text(emp.zip4 ?? '', 142, 145),
    blank(146, 195),
    // Box 16 wages — previous, corrected
    money(prevWages, 196, 206),
    money(currWages, 207, 217),
    // Box 17 tax — previous, corrected
    money(prevTax, 218, 228),
    money(currTax, 229, 239),
    blank(240, 270),
    // Local wages prev/curr — zero until local tax support lands.
    money(0, 271, 281),
    money(0, 282, 292),
    money(0, 293, 303), // local tax prev
    money(0, 304, 314), // local tax curr
    blank(315, 512),
  ];
  return assemble(fields);
}

interface RctTotals {
  rcwCount: number;
  deltaBox1: number;
  deltaBox2: number;
  deltaBox3: number;
  deltaBox4: number;
  deltaBox5: number;
  deltaBox6: number;
}

function newRctTotals(): RctTotals {
  return {
    rcwCount: 0,
    deltaBox1: 0,
    deltaBox2: 0,
    deltaBox3: 0,
    deltaBox4: 0,
    deltaBox5: 0,
    deltaBox6: 0,
  };
}

function buildRCT(t: RctTotals): string {
  // RCT TOTAL RECORD — closes an RCE block. The dollar fields carry the
  // SUM of (corrected - previous) per box across the RCWs. SSA matches
  // these against the per-RCW deltas; the absolute totals don't help
  // them since each W-2c is a delta. Negative deltas use the
  // SSA-prescribed signed-money format (leading '-' for negatives).
  const fields: Field[] = [
    fixed('RCT', 1, 3),
    digits(String(t.rcwCount).padStart(7, '0'), 4, 10),
    signedMoney(t.deltaBox1, 11, 25),
    signedMoney(t.deltaBox2, 26, 40),
    signedMoney(t.deltaBox3, 41, 55),
    signedMoney(t.deltaBox4, 56, 70),
    signedMoney(t.deltaBox5, 71, 85),
    signedMoney(t.deltaBox6, 86, 100),
    blank(101, 512),
  ];
  return assemble(fields);
}

function buildRCF(input: { rcwCount: number }): string {
  const fields: Field[] = [
    fixed('RCF', 1, 3),
    blank(4, 8),
    digits(String(input.rcwCount).padStart(9, '0'), 9, 17),
    blank(18, 512),
  ];
  return assemble(fields);
}

// ---- Field primitives — copied from efw2.ts so the lib stays standalone
// ---- and the W2 path doesn't break when this gets edited. -----------

interface Field {
  start: number;
  end: number;
  value: string;
}

function fixed(value: string, start: number, end: number): Field {
  const len = end - start + 1;
  if (value.length !== len) {
    throw new Error(`fixed value "${value}" length ${value.length} ≠ field width ${len} (${start}-${end})`);
  }
  return { start, end, value };
}

function text(raw: string, start: number, end: number): Field {
  const len = end - start + 1;
  return {
    start,
    end,
    value: ascii(raw).slice(0, len).padEnd(len, ' '),
  };
}

function digits(raw: string, start: number, end: number): Field {
  const len = end - start + 1;
  if (!/^\d+$/.test(raw)) {
    throw new Error(`digits value "${raw}" has non-numeric characters (${start}-${end})`);
  }
  return {
    start,
    end,
    value: raw.slice(0, len).padStart(len, '0'),
  };
}

function blank(start: number, end: number): Field {
  const len = end - start + 1;
  return { start, end, value: ' '.repeat(len) };
}

function money(amount: number, start: number, end: number): Field {
  const len = end - start + 1;
  const cents = Math.max(0, Math.round(amount * 100));
  const str = String(cents);
  if (str.length > len) {
    throw new Error(`money ${amount} (${cents}¢) exceeds field width ${len} (${start}-${end})`);
  }
  return { start, end, value: str.padStart(len, '0') };
}

/**
 * Signed cents — leading '-' for negatives. The SSA W-2c spec uses this
 * for delta totals on the RCT record so a corrected W-2c that REDUCES
 * wages reports a negative figure rather than an absolute. Width covers
 * sign + digits.
 */
function signedMoney(amount: number, start: number, end: number): Field {
  const len = end - start + 1;
  const cents = Math.round(amount * 100);
  const abs = Math.abs(cents).toString();
  if (cents < 0) {
    if (abs.length > len - 1) {
      throw new Error(`signedMoney ${amount} exceeds field width ${len} (${start}-${end})`);
    }
    return { start, end, value: '-' + abs.padStart(len - 1, '0') };
  }
  if (abs.length > len) {
    throw new Error(`signedMoney ${amount} exceeds field width ${len} (${start}-${end})`);
  }
  return { start, end, value: abs.padStart(len, '0') };
}

function ascii(s: string): string {
  return s
    .normalize('NFKD')
    .replace(/[^\x20-\x7E]/g, ' ')
    .replace(/\s+/g, ' ');
}

function stripPhone(s: string): string {
  return s.replace(/[^0-9]/g, '');
}

function assemble(fields: Field[]): string {
  const sorted = [...fields].sort((a, b) => a.start - b.start);
  let cursor = 1;
  const parts: string[] = [];
  for (const f of sorted) {
    if (f.start !== cursor) {
      throw new Error(
        `EFW2C record gap or overlap: field ${f.start}-${f.end} expected to start at ${cursor}`,
      );
    }
    parts.push(f.value);
    cursor = f.end + 1;
  }
  if (cursor !== RECORD_LEN + 1) {
    throw new Error(
      `EFW2C record length ${cursor - 1} ≠ ${RECORD_LEN}; missing trailing field?`,
    );
  }
  const line = parts.join('');
  if (line.length !== RECORD_LEN) {
    throw new Error(`EFW2C record assembled to ${line.length} chars, expected ${RECORD_LEN}`);
  }
  return line;
}
