// Gap 1 — EFW2 e-file generator (SSA Pub 42-007).
//
// Builds the fixed-width text file that the SSA Business Services Online
// (BSO) portal accepts as the electronic equivalent of paper W-2 Copy A.
// Each record is exactly 512 characters wide; lines are joined with CRLF
// and the file is sent as plain ASCII (no BOM, no UTF-8).
//
//   RA  Submitter        — one per file, first record
//   RE  Employer         — opens an employer (EIN) block
//   RW  Employee wage    — one per W-2
//   RO  Employee optional— after its RW, only when an RO field is non-zero
//   RS  State            — after its RW/RO, one per state (and per extra locality)
//   RT  Total            — closes the RE block: RW count and RW dollar totals
//   RU  Total optional   — after RT, only when the block has RO records
//   RV  State total      — after RT/RU, only when the block has RS records
//   RF  Final            — last record: RW count across the file
//
// Positions: SSA Publication 42-007, EFW2 Tax Year 2025, Version 3.3
// (01/20/2026), sections 4.4–4.13 and Appendix E (paper-box cross
// reference). The TY2026 publication (26efw2.pdf) could not be retrieved
// (ssa.gov refuses automated download), so the 2026 additions — Box 12 TA,
// TP, TT and Box 14b — are refused rather than guessed at (efw2Unsupported).
//
// Validate every file with AccuWage Online before a BSO upload:
//   https://www.ssa.gov/employer/accuwage/
// RS (state) records are passed through by SSA only to states that ask for
// them; each state's own EFW2 variant (taxing-entity code, optional code,
// "other state data", supplemental data) is CONFIRM per state.

import type { W2Boxes, W2LocalLine, W2StateLine } from './w2Aggregator.js';

const RECORD_LEN = 512;

export interface Efw2Submitter {
  /** 9 digits, no dashes. */
  ein: string;
  /** SSA-assigned BSO User ID (8 characters). */
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
  /** "98" in-house program (default) or "99" off-the-shelf software (needs a NACTP vendor code). */
  softwareCode?: '98' | '99';
  vendorCode?: string | null;
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
  /** N none apply (default), T 501c non-govt, S state/local non-501c, Y state/local 501c, F federal. */
  kindOfEmployer?: 'N' | 'T' | 'S' | 'Y' | 'F';
  /** R regular 941 (default), F regular 944, A agriculture 943, H household, M military, Q MQGE, X railroad. */
  employmentCode?: 'R' | 'F' | 'A' | 'H' | 'M' | 'Q' | 'X';
  /** Employer contact; defaults to the submitter's. */
  contactName?: string | null;
  contactPhone?: string | null;
  contactEmail?: string | null;
  /** State employer account numbers, by state (RS positions 248-267). */
  stateAccountNumbers?: Record<string, string>;
  /** Last tax year this EIN files W-2s (RE position 26). */
  terminating?: boolean;
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
  /** One RE block per file (multi-employer / PEO files are a future add). */
  employer: Efw2Employer;
  employees: Efw2Employee[];
}

/**
 * What this file layout cannot carry. Rather than write a W-2 that
 * silently drops an amount, the build refuses and names what is missing.
 *
 *   - Tax year 2026 adds Box 12 TA / TP / TT and Box 14b (Treasury Tipped
 *     Occupation Code) — OBBBA §§70201, 70202, 70204. SSA's EFW2 for TY2026
 *     defines new fields for them; their positions could not be confirmed
 *     (ssa.gov refused retrieval of 26efw2.pdf), so they are not guessed at.
 *   - Box 12 codes K (golden parachute excise), L (substantiated business
 *     expenses) and P (moving expenses) and J (nontaxable sick pay) have no
 *     EFW2 field by design (Appendix E): they do not block a file.
 *
 * File those W-2s through the e-file provider (Pay → Tax filing), which
 * submits every box.
 */
export interface Efw2Gap {
  ssnLast4: string;
  name: string;
  missing: string[];
}

export class Efw2UnsupportedError extends Error {
  constructor(public readonly gaps: Efw2Gap[]) {
    super(
      `This SSA file can't carry ${gaps.length === 1 ? 'one W-2' : `${gaps.length} W-2s`} in full ` +
        `(${[...new Set(gaps.flatMap((g) => g.missing))].join(', ')}). File them through the e-file provider instead.`,
    );
    this.name = 'Efw2UnsupportedError';
  }
}

/** Box 12 codes and where each lives in the TY2025 layout. */
const RW_CODE: Record<string, [number, number]> = {
  D: [287, 297],
  E: [298, 308],
  F: [309, 319],
  G: [320, 330],
  H: [331, 341],
  W: [364, 374],
  Q: [386, 396],
  C: [408, 418],
  V: [419, 429],
  Y: [430, 440],
  AA: [441, 451],
  BB: [452, 462],
  DD: [463, 473],
  FF: [474, 484],
};
const RO_CODE: Record<string, [number, number]> = {
  R: [34, 44],
  S: [45, 55],
  T: [56, 66],
  M: [67, 77],
  N: [78, 88],
  Z: [89, 99],
  EE: [111, 121],
  GG: [122, 132],
  HH: [133, 143],
  II: [144, 154],
};
/** Codes with no EFW2 field (Appendix E): reported on the paper form only. */
const NO_FIELD = new Set(['J', 'K', 'L', 'P']);
/** Codes A and B share RO 23-33 (uncollected tax on tips). */
const RO_TIPS = new Set(['A', 'B']);

export function efw2Unsupported(input: Efw2File): Efw2Gap[] {
  const gaps: Efw2Gap[] = [];
  const ty = input.employer.taxYear;
  for (const e of input.employees) {
    const b = e.boxes;
    const missing: string[] = [];
    for (const c of b.box12 ?? []) {
      if (c.amount === 0) continue;
      if (c.code === 'TA' || c.code === 'TP' || c.code === 'TT') missing.push(`Box 12 ${c.code} (TY${ty} position not confirmed)`);
      else if (!RW_CODE[c.code] && !RO_CODE[c.code] && !NO_FIELD.has(c.code) && !RO_TIPS.has(c.code)) missing.push(`Box 12 ${c.code}`);
    }
    if ((b.box14bTippedOccupationCodes ?? []).length > 0) missing.push(`Box 14b (TY${ty} position not confirmed)`);
    if (missing.length > 0) gaps.push({ ssnLast4: e.ssn.slice(-4), name: `${e.firstName} ${e.lastName}`, missing });
  }
  return gaps;
}

const code12 = (b: W2Boxes, code: string) => (b.box12 ?? []).filter((c) => c.code === code).reduce((s, c) => s + c.amount, 0);
const needsRo = (b: W2Boxes) => (b.box12 ?? []).some((c) => c.amount !== 0 && (RO_CODE[c.code] || RO_TIPS.has(c.code)));

/**
 * Builds the full EFW2 file as a string (CRLF-joined records, no
 * trailing newline). Caller writes it to disk or streams it as the
 * download body — encoding must be ASCII / Windows-1252.
 */
export function buildEfw2File(input: Efw2File): string {
  const unsupported = efw2Unsupported(input);
  if (unsupported.length > 0) throw new Efw2UnsupportedError(unsupported);
  const records: string[] = [];
  records.push(buildRA(input.submitter));
  records.push(buildRE(input.employer, input.submitter, input.employees.some((e) => e.boxes.box13ThirdPartySickPay)));

  const rt = new Map<string, number>();
  const ru = new Map<string, number>();
  let rwCount = 0;
  let roCount = 0;
  let rsCount = 0;
  const addT = (m: Map<string, number>, k: string, n: number) => m.set(k, (m.get(k) ?? 0) + n);

  for (const employee of input.employees) {
    const b = employee.boxes;
    records.push(buildRW(employee));
    rwCount += 1;
    addT(rt, 'box1', b.box1Wages);
    addT(rt, 'box2', b.box2FitWithheld);
    addT(rt, 'box3', b.box3SsWages);
    addT(rt, 'box4', b.box4SsTax);
    addT(rt, 'box5', b.box5MedicareWages);
    addT(rt, 'box6', b.box6MedicareTax);
    addT(rt, 'box7', b.box7SsTips ?? 0);
    addT(rt, 'box10', b.box10DependentCare ?? 0);
    for (const c of Object.keys(RW_CODE)) addT(rt, c, code12(b, c));
    if (needsRo(b)) {
      records.push(buildRO(employee));
      roCount += 1;
      addT(ru, 'AB', code12(b, 'A') + code12(b, 'B'));
      for (const c of Object.keys(RO_CODE)) addT(ru, c, code12(b, c));
    }
    for (const rs of rsRecords(employee, input.employer)) {
      records.push(rs);
      rsCount += 1;
    }
  }

  records.push(buildRT(rwCount, rt));
  if (roCount > 0) records.push(buildRU(roCount, ru));
  if (rsCount > 0) records.push(assemble([fixed('RV', 1, 2), blank(3, 512)]));
  records.push(assemble([fixed('RF', 1, 2), blank(3, 7), digits(String(rwCount), 8, 16), blank(17, 512)]));
  return records.join('\r\n');
}

// ---- Record builders (TY2025 Pub 42-007 positions) -----------------------

function buildRA(s: Efw2Submitter): string {
  const software = s.softwareCode ?? '98';
  return assemble([
    fixed('RA', 1, 2),
    digits(s.ein, 3, 11),
    text(s.userId, 12, 19),
    software === '99' && s.vendorCode ? digits(s.vendorCode, 20, 23) : blank(20, 23),
    blank(24, 28),
    fixed('0', 29, 29), // Resub indicator: original
    blank(30, 35), // Resub WFID
    fixed(software, 36, 37),
    // Company (the submitter's company)
    text(s.name, 38, 94),
    blank(95, 116), // Location address
    text(s.addressLine1, 117, 138), // Delivery address
    text(s.city, 139, 160),
    text(s.state, 161, 162),
    digits(s.zip5, 163, 167),
    text(s.zip4 ?? '', 168, 171),
    blank(172, 176),
    blank(177, 199), // Foreign state/province
    blank(200, 214), // Foreign postal code
    blank(215, 216), // Country code (blank = US)
    // Submitter
    text(s.name, 217, 273),
    blank(274, 295),
    text(s.addressLine1, 296, 317),
    text(s.city, 318, 339),
    text(s.state, 340, 341),
    digits(s.zip5, 342, 346),
    text(s.zip4 ?? '', 347, 350),
    blank(351, 355),
    blank(356, 378),
    blank(379, 393),
    blank(394, 395),
    text(s.contactName, 396, 422),
    text(stripPhone(s.contactPhone), 423, 437),
    blank(438, 442), // Phone extension
    blank(443, 445),
    text(s.contactEmail, 446, 485),
    blank(486, 488),
    blank(489, 498), // Fax
    blank(499, 499),
    fixed('L', 500, 500), // Preparer code: L = self-prepared
    blank(501, 512),
  ]);
}

function buildRE(e: Efw2Employer, s: Efw2Submitter, thirdPartySick: boolean): string {
  return assemble([
    fixed('RE', 1, 2),
    digits(String(e.taxYear), 3, 6),
    blank(7, 7), // Agent indicator
    digits(e.ein, 8, 16),
    blank(17, 25), // Agent for EIN
    fixed(e.terminating ? '1' : '0', 26, 26),
    blank(27, 30), // Establishment number
    blank(31, 39), // Other EIN
    text(e.name, 40, 96),
    blank(97, 118), // Location address
    text(e.addressLine1, 119, 140), // Delivery address
    text(e.city, 141, 162),
    text(e.state, 163, 164),
    digits(e.zip5, 165, 169),
    text(e.zip4 ?? '', 170, 173),
    fixed(e.kindOfEmployer ?? 'N', 174, 174),
    blank(175, 178),
    blank(179, 201),
    blank(202, 216),
    blank(217, 218),
    fixed(e.employmentCode ?? 'R', 219, 219),
    blank(220, 220), // Tax jurisdiction: blank = W-2
    fixed(thirdPartySick ? '1' : '0', 221, 221),
    text(e.contactName ?? s.contactName, 222, 248),
    text(stripPhone(e.contactPhone ?? s.contactPhone), 249, 263),
    blank(264, 268),
    blank(269, 278), // Fax
    text(e.contactEmail ?? s.contactEmail, 279, 318),
    blank(319, 512),
  ]);
}

function buildRW(emp: Efw2Employee): string {
  const b = emp.boxes;
  const codeFields = Object.entries(RW_CODE).map(([c, [a, z]]) => money(code12(b, c), a, z));
  return assemble([
    fixed('RW', 1, 2),
    digits(emp.ssn, 3, 11),
    text(emp.firstName, 12, 26),
    text(emp.middleName ?? '', 27, 41),
    text(emp.lastName, 42, 61),
    text(emp.suffix ?? '', 62, 65),
    blank(66, 87), // Location address
    text([emp.addressLine1, emp.addressLine2].filter(Boolean).join(' '), 88, 109), // Delivery address
    text(emp.city, 110, 131),
    text(emp.state, 132, 133),
    digits(emp.zip5, 134, 138),
    text(emp.zip4 ?? '', 139, 142),
    blank(143, 147),
    blank(148, 170), // Foreign state/province
    blank(171, 185), // Foreign postal code
    blank(186, 187), // Country code
    money(b.box1Wages, 188, 198),
    money(b.box2FitWithheld, 199, 209),
    money(b.box3SsWages, 210, 220),
    money(b.box4SsTax, 221, 231),
    money(b.box5MedicareWages, 232, 242),
    money(b.box6MedicareTax, 243, 253),
    money(b.box7SsTips ?? 0, 254, 264),
    blank(265, 275),
    money(b.box10DependentCare ?? 0, 276, 286),
    ...codeFields,
    blank(342, 352),
    money(0, 353, 363), // Box 11 nonqualified §457
    money(0, 375, 385), // Box 11 nonqualified not §457
    blank(397, 407),
    blank(485, 485),
    fixed('0', 486, 486), // Statutory employee
    blank(487, 487),
    fixed(b.box13RetirementPlan ? '1' : '0', 488, 488),
    fixed(b.box13ThirdPartySickPay ? '1' : '0', 489, 489),
    blank(490, 512),
  ]);
}

function buildRO(emp: Efw2Employee): string {
  const b = emp.boxes;
  return assemble([
    fixed('RO', 1, 2),
    blank(3, 11),
    money(0, 12, 22), // Allocated tips (Box 8)
    money(code12(b, 'A') + code12(b, 'B'), 23, 33),
    ...Object.entries(RO_CODE).map(([c, [a, z]]) => money(code12(b, c), a, z)),
    blank(100, 110),
    blank(155, 274),
    // Puerto Rico / Virgin Islands fields (W-2PR, W-2VI) — not used for a W-2.
    money(0, 275, 285),
    money(0, 286, 296),
    money(0, 297, 307),
    money(0, 308, 318),
    money(0, 319, 329),
    money(0, 330, 340),
    money(0, 341, 351),
    blank(352, 362),
    money(0, 363, 373),
    money(0, 374, 384),
    blank(385, 512),
  ]);
}

/** SSA numeric state codes (Appendix F). */
const STATE_NUMERIC: Record<string, string> = {
  AL: '01', AK: '02', AZ: '04', AR: '05', CA: '06', CO: '08', CT: '09', DE: '10', DC: '11', FL: '12', GA: '13', HI: '15', ID: '16', IL: '17', IN: '18', IA: '19', KS: '20', KY: '21', LA: '22', ME: '23', MD: '24', MA: '25', MI: '26', MN: '27', MS: '28', MO: '29', MT: '30', NE: '31', NV: '32', NH: '33', NJ: '34', NM: '35', NY: '36', NC: '37', ND: '38', OH: '39', OK: '40', OR: '41', PA: '42', RI: '44', SC: '45', SD: '46', TN: '47', TX: '48', UT: '49', VT: '50', VA: '51', WA: '53', WV: '54', WI: '55', WY: '56',
};
export function stateNumericCode(usps: string): string | null {
  return STATE_NUMERIC[usps.toUpperCase()] ?? null;
}

/** Tax type code for RS position 308. */
function taxTypeCode(l: W2LocalLine): string {
  if (l.kind === 'SCHOOL') return 'E';
  if (/COUNTY|^IN-|CNTY/i.test(`${l.code} ${l.locality}`)) return 'D';
  if (l.kind === 'LOCAL') return 'C';
  return 'F';
}

/**
 * RS records for one employee: one per state line, carrying that state's
 * first locality; a second locality in the same state rides an extra RS
 * record with the state wage fields zero, so state totals are not doubled.
 * CONFIRM: each state's treatment of multiple localities on RS records.
 */
function rsRecords(emp: Efw2Employee, employer: Efw2Employer): string[] {
  const b = emp.boxes;
  const out: string[] = [];
  const locals = [...(b.localLines ?? [])];
  const states = [...b.stateLines];
  // A locality in a state without a state line still needs a record.
  for (const l of locals) if (l.state && !states.some((s) => s.state === l.state)) states.push({ state: l.state, stateWages: 0, stateIncomeTax: 0 });
  for (const st of states) {
    const numeric = stateNumericCode(st.state);
    if (!numeric) continue;
    const mine = locals.filter((l) => l.state === st.state);
    out.push(buildRS(emp, employer, numeric, st, mine[0] ?? null));
    for (const extra of mine.slice(1)) out.push(buildRS(emp, employer, numeric, { state: st.state, stateWages: 0, stateIncomeTax: 0 }, extra));
  }
  return out;
}

function buildRS(emp: Efw2Employee, employer: Efw2Employer, numeric: string, line: W2StateLine, local: W2LocalLine | null): string {
  const account = employer.stateAccountNumbers?.[line.state] ?? '';
  return assemble([
    fixed('RS', 1, 2),
    fixed(numeric, 3, 4),
    blank(5, 9), // Taxing entity code (state/local defined)
    digits(emp.ssn, 10, 18),
    text(emp.firstName, 19, 33),
    text(emp.middleName ?? '', 34, 48),
    text(emp.lastName, 49, 68),
    text(emp.suffix ?? '', 69, 72),
    blank(73, 94), // Location address
    text([emp.addressLine1, emp.addressLine2].filter(Boolean).join(' '), 95, 116),
    text(emp.city, 117, 138),
    text(emp.state, 139, 140),
    digits(emp.zip5, 141, 145),
    text(emp.zip4 ?? '', 146, 149),
    blank(150, 154),
    blank(155, 177),
    blank(178, 192),
    blank(193, 194),
    // Unemployment reporting (195-247) is not used on an annual W-2 file.
    blank(195, 196),
    blank(197, 202),
    blank(203, 213),
    blank(214, 224),
    blank(225, 226),
    blank(227, 234),
    blank(235, 242),
    blank(243, 247),
    text(account, 248, 267),
    blank(268, 273),
    fixed(numeric, 274, 275),
    money(line.stateWages, 276, 286),
    money(line.stateIncomeTax, 287, 297),
    blank(298, 307), // Other state data (state defined)
    local ? fixed(taxTypeCode(local), 308, 308) : blank(308, 308),
    local ? money(local.localWages, 309, 319) : blank(309, 319),
    local ? money(local.localIncomeTax, 320, 330) : blank(320, 330),
    blank(331, 337), // State control number
    local ? text(local.locality, 338, 412) : blank(338, 412), // Supplemental data 1: locality name
    blank(413, 487),
    blank(488, 512),
  ]);
}

const RT_CODE: Record<string, [number, number]> = {
  D: [145, 159],
  E: [160, 174],
  F: [175, 189],
  G: [190, 204],
  H: [205, 219],
  W: [250, 264],
  Q: [280, 294],
  DD: [295, 309],
  C: [310, 324],
  V: [340, 354],
  Y: [355, 369],
  AA: [370, 384],
  BB: [385, 399],
  FF: [400, 414],
};

function buildRT(rwCount: number, t: Map<string, number>): string {
  const g = (k: string) => t.get(k) ?? 0;
  return assemble([
    fixed('RT', 1, 2),
    digits(String(rwCount), 3, 9),
    money(g('box1'), 10, 24),
    money(g('box2'), 25, 39),
    money(g('box3'), 40, 54),
    money(g('box4'), 55, 69),
    money(g('box5'), 70, 84),
    money(g('box6'), 85, 99),
    money(g('box7'), 100, 114),
    blank(115, 129),
    money(g('box10'), 130, 144),
    ...Object.entries(RT_CODE).map(([c, [a, z]]) => money(g(c), a, z)),
    blank(220, 234),
    money(0, 235, 249), // Nonqualified §457
    money(0, 265, 279), // Nonqualified not §457
    money(0, 325, 339), // Income tax withheld by third-party payer
    blank(415, 512),
  ]);
}

const RU_CODE: Record<string, [number, number]> = {
  R: [40, 54],
  S: [55, 69],
  T: [70, 84],
  M: [85, 99],
  N: [100, 114],
  Z: [115, 129],
  EE: [145, 159],
  GG: [160, 174],
  HH: [175, 189],
  II: [190, 204],
};

function buildRU(roCount: number, t: Map<string, number>): string {
  const g = (k: string) => t.get(k) ?? 0;
  return assemble([
    fixed('RU', 1, 2),
    digits(String(roCount), 3, 9),
    money(0, 10, 24), // Allocated tips
    money(g('AB'), 25, 39),
    ...Object.entries(RU_CODE).map(([c, [a, z]]) => money(g(c), a, z)),
    blank(130, 144),
    blank(205, 354),
    ...[355, 370, 385, 400, 415, 430, 445, 460, 475].map((a) => money(0, a, a + 14)), // PR / VI totals
    blank(490, 512),
  ]);
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
