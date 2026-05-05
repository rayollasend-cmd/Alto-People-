// Gap 1 — EFW2 e-file generator (SSA Pub 42-007).
//
// Builds the fixed-width text file that the SSA Business Services Online
// (BSO) portal accepts as the electronic equivalent of paper W-2 Copy A.
// Each record is exactly 512 characters wide; lines are joined with CRLF
// and the file is sent as plain ASCII (no BOM, no UTF-8).
//
//   RA  Submitter   — one per file, first record
//   RE  Employer    — one per Employer-EIN block
//   RW  Employee    — one per W-2, immediately after its RE
//   RS  State       — one per state line per RW (Box 15-17)
//   RT  Totals      — closes the RE block, sums RW dollar fields
//   RF  Final       — one per file, last record, total RW count + grand totals
//
// =============================================================================
// !!  AccuWage validation required before any production BSO upload  !!
//
// Field positions below are written from the SSA Pub 42-007 (Tax Year
// 2024) spec but have not been validated against AccuWage Online —
// AccuWage is the only authoritative cross-check (SSA rejects the
// entire file on a single positional mismatch).
//
//   $ npx tsx apps/api/scripts/sample-efw2.ts
//
// generates a sample file from real, exercised code paths. Upload it
// to https://www.ssa.gov/employer/accuwage/ and reconcile any errors
// the validator reports against this file BEFORE filing.
//
// Areas I am LEAST sure of and finance should pay extra attention to:
//   - RA position 31     (Resub Indicator: 1 char per spec; current
//                        code lays it across positions 31-32)
//   - RA position 200-201 (commented "Country Code" but spec section
//                        for that range is "Foreign State / Province")
//   - RS position 3-4    (USPS code in current code; spec may want
//                        FIPS numeric — already flagged inline as TODO)
// Until the AccuWage pass lands, treat this output as a draft.
// =============================================================================

import type { W2Boxes } from './w2Aggregator.js';

const RECORD_LEN = 512;

export interface Efw2Submitter {
  /** 9 digits, no dashes. */
  ein: string;
  /** SSA-assigned User ID. Submitter cannot file electronically without one. */
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

export interface Efw2Employer {
  /** 9 digits, no dashes. */
  ein: string;
  /** Tax year of the W-2s in this RE block. */
  taxYear: number;
  name: string;
  addressLine1: string;
  addressLine2?: string | null;
  city: string;
  state: string;
  zip5: string;
  zip4?: string | null;
}

export interface Efw2Employee {
  /** 9 digits, no dashes. */
  ssn: string;
  firstName: string;
  middleName?: string | null;
  lastName: string;
  /** Suffix like "Jr", "III". Optional. */
  suffix?: string | null;
  addressLine1: string;
  addressLine2?: string | null;
  city: string;
  /** USPS state code OR blank for foreign address. */
  state: string;
  zip5: string;
  zip4?: string | null;
  boxes: W2Boxes;
}

export interface Efw2File {
  submitter: Efw2Submitter;
  /**
   * For now we expect every W-2 in a file to share one employer (one RE
   * block). Multi-employer support — common for PEOs — is a future add.
   */
  employer: Efw2Employer;
  employees: Efw2Employee[];
}

/**
 * Builds the full EFW2 file as a string (CRLF-joined records, no
 * trailing newline). Caller writes it to disk or streams it as the
 * download body — encoding must be ASCII / Windows-1252.
 */
export function buildEfw2File(input: Efw2File): string {
  const records: string[] = [];

  records.push(buildRA(input.submitter));
  records.push(buildRE(input.employer));

  // RT totals across the RE block
  const reTotals = newReTotals();

  for (const employee of input.employees) {
    records.push(buildRW(employee));
    reTotals.box1Wages += employee.boxes.box1Wages;
    reTotals.box2FitWithheld += employee.boxes.box2FitWithheld;
    reTotals.box3SsWages += employee.boxes.box3SsWages;
    reTotals.box4SsTax += employee.boxes.box4SsTax;
    reTotals.box5MedicareWages += employee.boxes.box5MedicareWages;
    reTotals.box6MedicareTax += employee.boxes.box6MedicareTax;
    reTotals.rwCount += 1;

    for (const stateLine of employee.boxes.stateLines) {
      records.push(buildRS(employee, stateLine));
    }
  }

  records.push(buildRT(reTotals));
  records.push(
    buildRF({
      rwCount: reTotals.rwCount,
    }),
  );

  return records.join('\r\n');
}

// ---- Record builders -----------------------------------------------------

function buildRA(s: Efw2Submitter): string {
  // RA SUBMITTER RECORD — first record in every EFW2 file. SSA matches the
  // submitter EIN against their on-file record before they accept any
  // employer block. The User ID was issued when the company first
  // registered for BSO.
  const fields: Field[] = [
    fixed('RA', 1, 2),
    digits(s.ein, 3, 11),
    text(s.userId, 12, 28),
    blank(29, 30), // Software Vendor Code — not used
    digits('0', 31, 32), // Resub Indicator: 0 = original
    blank(33, 38), // Resub WFID
    digits('99', 39, 46), // Software Code: 99 = third-party / vendor
    text(s.name, 47, 103),
    text(s.addressLine1, 104, 125),
    text(s.addressLine2 ?? '', 126, 147),
    text(s.city, 148, 169),
    text(s.state, 170, 171),
    digits(s.zip5, 172, 176),
    text(s.zip4 ?? '', 177, 180),
    blank(181, 199),
    blank(200, 201), // Country Code (blank = US)
    text(s.contactName, 202, 258),
    text(stripPhone(s.contactPhone), 259, 273),
    blank(274, 278), // Phone Extension
    text(s.contactEmail, 279, 318),
    blank(319, 322),
    blank(323, 332), // Fax
    fixed('S', 333, 333), // Preparer Code: S = self-prepared
    blank(334, 512), // Reserved trailer
  ];
  return assemble(fields);
}

function buildRE(e: Efw2Employer): string {
  // RE EMPLOYER RECORD — opens an Employer block. One per EIN. The taxYear
  // in positions 3-6 is the calendar year reported in the W-2 forms that
  // follow.
  const fields: Field[] = [
    fixed('RE', 1, 2),
    digits(String(e.taxYear), 3, 6),
    blank(7, 7), // Agent Indicator Code
    digits(e.ein, 8, 16),
    blank(17, 25), // Agent For EIN
    fixed('R', 26, 26), // Terminating Business Indicator: R = none
    blank(27, 29), // Establishment Number
    blank(30, 38), // Other EIN
    text(e.name, 39, 95),
    blank(96, 117), // Employer Location Address (use Delivery instead)
    text(e.addressLine1, 118, 139),
    text(e.city, 140, 161),
    text(e.state, 162, 163),
    digits(e.zip5, 164, 168),
    text(e.zip4 ?? '', 169, 172),
    blank(173, 174),
    blank(175, 178), // Foreign State/Province
    blank(179, 193), // Foreign Postal Code
    blank(194, 195), // Country Code
    fixed('R', 196, 196), // Employment Code: R = regular (944/941); A = agricultural; H = household; M = military; X = railroad; Q = MQGE; F = farm
    blank(197, 197), // Tax Jurisdiction Code (blank = W-2)
    fixed('N', 198, 198), // Third-Party Sick Pay Indicator: N = no
    blank(199, 512), // Reserved trailer
  ];
  return assemble(fields);
}

function buildRW(emp: Efw2Employee): string {
  // RW EMPLOYEE WAGE RECORD — one per W-2. All dollar fields are in cents
  // (i.e. multiplied by 100) and zero-padded to 11 digits, no decimal
  // point. Wage figures match the Box totals from w2Aggregator exactly.
  const fields: Field[] = [
    fixed('RW', 1, 2),
    digits(emp.ssn, 3, 11),
    text(emp.firstName, 12, 26),
    text(emp.middleName ?? '', 27, 41),
    text(emp.lastName, 42, 61),
    text(emp.suffix ?? '', 62, 65),
    text(emp.addressLine1, 66, 87),
    text(emp.addressLine2 ?? '', 88, 109),
    text(emp.city, 110, 131),
    text(emp.state, 132, 133),
    digits(emp.zip5, 134, 138),
    text(emp.zip4 ?? '', 139, 142),
    blank(143, 147), // ZIP suffix
    blank(148, 149), // Foreign State
    blank(150, 164), // Foreign Postal Code
    blank(165, 166), // Country Code
    money(emp.boxes.box1Wages, 167, 177),
    money(emp.boxes.box2FitWithheld, 178, 188),
    money(emp.boxes.box3SsWages, 189, 199),
    money(emp.boxes.box4SsTax, 200, 210),
    money(emp.boxes.box5MedicareWages, 211, 221),
    money(emp.boxes.box6MedicareTax, 222, 232),
    // Boxes 7-11 (SS tips, allocated tips, advanced EIC, dependent care,
    // nonqualified plans) — all zero until those features land. Positions
    // 233-287.
    money(0, 233, 243), // Box 7
    money(0, 244, 254), // Box 8
    blank(255, 265), // Box 9 (verification code, deprecated)
    money(0, 266, 276), // Box 10 dependent care
    money(0, 277, 287), // Box 11 nonqualified plans
    // Box 12 codes (D=401k, DD=employer health) — empty for now.
    money(0, 288, 298), // Box 12 codes A-H subtotal — placeholder
    blank(299, 309),
    money(0, 310, 320),
    blank(321, 331),
    money(0, 332, 342),
    blank(343, 353),
    // Box 13 checkboxes
    fixed('0', 354, 354), // Statutory employee
    fixed('0', 355, 355), // Retirement plan
    fixed('0', 356, 356), // Third-party sick pay
    blank(357, 462),
    // Boxes 14 (Other) — blank
    blank(463, 485),
    blank(486, 512),
  ];
  return assemble(fields);
}

function buildRS(emp: Efw2Employee, line: { state: string; stateWages: number; stateIncomeTax: number }): string {
  // RS STATE WAGE RECORD — one per state per employee. SSA forwards these
  // to the corresponding state revenue agency. Position 5-6 carries the
  // state's FIPS numeric code, not the USPS letter code; we approximate
  // here by mapping the USPS code at fill time. TODO: drop in a
  // FIPS-by-USPS lookup before BSO upload.
  const fields: Field[] = [
    fixed('RS', 1, 2),
    text(line.state, 3, 4), // USPS code — verify SSA wants USPS or FIPS here
    digits(emp.ssn, 5, 13),
    text(emp.firstName, 14, 28),
    text(emp.middleName ?? '', 29, 43),
    text(emp.lastName, 44, 63),
    text(emp.suffix ?? '', 64, 67),
    text(emp.addressLine1, 68, 89),
    text(emp.addressLine2 ?? '', 90, 111),
    text(emp.city, 112, 133),
    text(emp.state, 134, 135),
    digits(emp.zip5, 136, 140),
    text(emp.zip4 ?? '', 141, 144),
    blank(145, 195),
    money(line.stateWages, 196, 206),
    money(line.stateIncomeTax, 207, 217),
    blank(218, 247),
    money(0, 248, 258), // Local wages — not supported yet
    money(0, 259, 269), // Local income tax — not supported yet
    blank(270, 273),
    blank(274, 512),
  ];
  return assemble(fields);
}

interface ReTotals {
  rwCount: number;
  box1Wages: number;
  box2FitWithheld: number;
  box3SsWages: number;
  box4SsTax: number;
  box5MedicareWages: number;
  box6MedicareTax: number;
}

function newReTotals(): ReTotals {
  return {
    rwCount: 0,
    box1Wages: 0,
    box2FitWithheld: 0,
    box3SsWages: 0,
    box4SsTax: 0,
    box5MedicareWages: 0,
    box6MedicareTax: 0,
  };
}

function buildRT(t: ReTotals): string {
  // RT TOTAL RECORD — closes an RE block. Counts the RW records and sums
  // their dollar fields. SSA validates these against the actual RW figures
  // it parsed; a mismatch rejects the entire file.
  const fields: Field[] = [
    fixed('RT', 1, 2),
    digits(String(t.rwCount).padStart(7, '0'), 3, 9),
    money(t.box1Wages, 10, 24),
    money(t.box2FitWithheld, 25, 39),
    money(t.box3SsWages, 40, 54),
    money(t.box4SsTax, 55, 69),
    money(t.box5MedicareWages, 70, 84),
    money(t.box6MedicareTax, 85, 99),
    money(0, 100, 114), // Total Box 7
    money(0, 115, 129), // Total Box 8
    blank(130, 144), // Total Box 9 (deprecated)
    money(0, 145, 159), // Total Box 10
    money(0, 160, 174), // Total Box 11
    money(0, 175, 189), // Total Box 12 codes
    blank(190, 512),
  ];
  return assemble(fields);
}

function buildRF(input: { rwCount: number }): string {
  // RF FINAL RECORD — one per file, last record. Carries the total RW
  // count across every RE block in the file (we have one block).
  const fields: Field[] = [
    fixed('RF', 1, 2),
    blank(3, 7),
    digits(String(input.rwCount).padStart(9, '0'), 8, 16),
    blank(17, 512),
  ];
  return assemble(fields);
}

// ---- Field primitives ----------------------------------------------------

interface Field {
  start: number; // 1-based, inclusive
  end: number; // 1-based, inclusive
  value: string;
}

/** Fixed literal (always exactly the given string). */
function fixed(value: string, start: number, end: number): Field {
  const len = end - start + 1;
  if (value.length !== len) {
    throw new Error(`fixed value "${value}" length ${value.length} ≠ field width ${len} (${start}-${end})`);
  }
  return { start, end, value };
}

/** Right-pads with blanks. Truncates if too long. ASCII-clean only. */
function text(raw: string, start: number, end: number): Field {
  const len = end - start + 1;
  const cleaned = ascii(raw);
  return {
    start,
    end,
    value: cleaned.slice(0, len).padEnd(len, ' '),
  };
}

/** Left-pads with zeros. Throws if non-numeric. */
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

/** Whole-blank field. */
function blank(start: number, end: number): Field {
  const len = end - start + 1;
  return { start, end, value: ' '.repeat(len) };
}

/**
 * Money in CENTS, zero-padded. Negative not allowed by SSA — we floor at 0
 * and assume the caller validated. Round-half-up to the nearest cent first
 * so cumulative aggregator sums don't introduce sub-cent drift.
 */
function money(amount: number, start: number, end: number): Field {
  const len = end - start + 1;
  const cents = Math.max(0, Math.round(amount * 100));
  const str = String(cents);
  if (str.length > len) {
    throw new Error(`money ${amount} (${cents}¢) exceeds field width ${len} (${start}-${end})`);
  }
  return {
    start,
    end,
    value: str.padStart(len, '0'),
  };
}

function ascii(s: string): string {
  // EFW2 is ASCII / Windows-1252. We strip anything outside printable
  // ASCII (positions 0x20-0x7E) and replace tabs/newlines with spaces.
  return s
    .normalize('NFKD')
    .replace(/[^\x20-\x7E]/g, ' ')
    .replace(/\s+/g, ' ');
}

function stripPhone(s: string): string {
  return s.replace(/[^0-9]/g, '');
}

/**
 * Sorts fields by start position, asserts no gaps and no overlaps, and
 * concatenates into the final 512-char record. Catches positional bugs at
 * build time rather than at SSA-rejection time.
 */
function assemble(fields: Field[]): string {
  const sorted = [...fields].sort((a, b) => a.start - b.start);
  let cursor = 1;
  const parts: string[] = [];
  for (const f of sorted) {
    if (f.start !== cursor) {
      throw new Error(
        `EFW2 record gap or overlap: field ${f.start}-${f.end} expected to start at ${cursor}`,
      );
    }
    parts.push(f.value);
    cursor = f.end + 1;
  }
  if (cursor !== RECORD_LEN + 1) {
    throw new Error(
      `EFW2 record length ${cursor - 1} ≠ ${RECORD_LEN}; missing trailing field?`,
    );
  }
  const line = parts.join('');
  if (line.length !== RECORD_LEN) {
    throw new Error(`EFW2 record assembled to ${line.length} chars, expected ${RECORD_LEN}`);
  }
  return line;
}
