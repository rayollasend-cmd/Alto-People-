// Gap 11 — IRS FIRE e-file generator (IRS Pub 1220, Tax Year 2024).
//
// Builds the fixed-width text file the IRS FIRE (Filing Information
// Returns Electronically) system accepts as the electronic equivalent
// of paper 1099-NEC / 1099-MISC Copy A. Each record is exactly 750
// characters wide; lines are joined with CRLF and the file is ASCII
// (no BOM, no UTF-8). Note: 750 chars — not the 512 EFW2 uses. Don't
// conflate the formats.
//
// Form support: pass `formType: 'NE'` (1099-NEC) or `'MI'` (1099-MISC)
// on the input; the same T/A/B/C/(K/)F skeleton is shared. The B
// record's payment-amount slots and the A record's "Type of Return" +
// "Amount Codes" fields differ per form; everything else is form-
// agnostic.
//
//   T  Transmitter   — one per file, first record
//   A  Payer         — opens a payer-EIN block
//   B  Payee         — one per 1099-NEC, immediately after its A
//   C  End-of-Payer  — closes the A block, sums B totals
//   K  State Totals  — optional, one per CF/SF state, between C and F
//   F  End-of-File   — one per file, last record, total payee count
//
// Combined Federal/State Filing: pass `cfsf` on the input to opt in.
// The IRS then forwards each B record (whose state is in the cfsf list)
// to that state, sparing a separate state filing — for participating
// states only. Non-participating states still require their own filing.
//
// =============================================================================
// !!  IRS FIRE test-system validation required before any production submission  !!
//
// Field positions below are written to the Pub 1220 (Tax Year 2024)
// spec but have not been validated against the IRS FIRE Test System
// (https://fire.test.irs.gov). The IRS rejects the entire file on any
// positional mismatch.
//
//   $ npx tsx apps/api/scripts/sample-efw2.ts
//
// generates a sample IRS-FIRE file alongside the EFW2/EFW2C samples.
// Take the output to fire.test.irs.gov, run a test transmission, and
// reconcile every error before filing for real.
// =============================================================================

import type { Form1099NecBoxes } from './f1099NecAggregator.js';
import type { Form1099MiscBoxes } from './f1099MiscAggregator.js';

const RECORD_LEN = 750;
const NUM_AMOUNT_SLOTS = 14;

/** Type of Return code — IRS Pub 1220 §B. NE = 1099-NEC, MI = 1099-MISC. */
export type IrsFireFormType = 'NE' | 'MI';

/**
 * Maps each form's box totals to the 14 fixed payment-amount slots in
 * the B record (and the matching control totals in C / K). Index 0 =
 * Slot 1, index 9 = Slot A (10), …, index 13 = Slot E (14). A null
 * entry means the slot is unused for that form (zeroed in the output).
 *
 * Slot codes for the Amount Codes field on the A record: '1'..'9' for
 * indices 0..8, then 'A'..'E' for indices 9..13.
 */
const SLOT_CODES = ['1', '2', '3', '4', '5', '6', '7', '8', '9', 'A', 'B', 'C', 'D', 'E'] as const;

function necSlots(boxes: Form1099NecBoxes): (number | null)[] {
  // Slot 1 = Box 1 (NEC), Slot 4 = Box 4 (FIT). Box 2 is a checkbox
  // (handled at fixed pos 556 in the B record), not a money slot.
  const arr: (number | null)[] = new Array(NUM_AMOUNT_SLOTS).fill(null);
  arr[0] = boxes.box1NonemployeeCompensation;
  arr[3] = boxes.box4FitWithheld;
  return arr;
}

function miscSlots(boxes: Form1099MiscBoxes): (number | null)[] {
  // 1099-MISC slot map per Pub 1220. Slot 7 is unused (Box 7 is a
  // checkbox, same as 1099-NEC's Box 2). Slot E (14) is the last one.
  const arr: (number | null)[] = new Array(NUM_AMOUNT_SLOTS).fill(null);
  arr[0] = boxes.box1Rents;
  arr[1] = boxes.box2Royalties;
  arr[2] = boxes.box3OtherIncome;
  arr[3] = boxes.box4FitWithheld;
  arr[4] = boxes.box5FishingBoatProceeds;
  arr[5] = boxes.box6MedicalHealthcarePayments;
  // arr[6] left null — Slot 7 is checkbox-only for 1099-MISC
  arr[7] = boxes.box8SubstitutePayments;
  arr[8] = boxes.box9CropInsuranceProceeds;
  arr[9] = boxes.box10GrossProceedsAttorney;
  arr[10] = boxes.box11FishForResale;
  arr[11] = boxes.box12Section409ADeferrals;
  arr[12] = boxes.box13ExcessGoldenParachute;
  arr[13] = boxes.box14NonqualifiedDeferred;
  return arr;
}

export interface IrsFireTransmitter {
  /**
   * 5-character Transmitter Control Code assigned by the IRS when you
   * register for FIRE. Without this you can't transmit; the field is
   * mandatory and validated against IRS records.
   */
  tcc: string;
  /** 9 digits, no dashes — the transmitter's EIN. */
  ein: string;
  name: string;
  contactName: string;
  contactPhone: string;
  contactEmail: string;
  /** Tax year of the returns in this file. */
  taxYear: number;
}

export interface IrsFirePayer {
  /** 9 digits, no dashes. */
  ein: string;
  name: string;
  /** 4-line stacked address per Pub 1220 §B record layout. */
  addressLine1: string;
  city: string;
  state: string;
  zip5: string;
  zip4?: string | null;
}

export interface IrsFirePayee {
  /**
   * 9-digit TIN — SSN for individuals (CONTRACTOR_1099_INDIVIDUAL),
   * EIN for businesses (CONTRACTOR_1099_BUSINESS). Caller passes
   * digits-only (no dashes); the format flag is computed below.
   */
  tin: string;
  /** "1" = SSN, "2" = EIN. Drives Type-of-TIN field on B record. */
  tinTypeCode: '1' | '2';
  /** Full legal name of recipient. */
  name: string;
  addressLine1: string;
  city: string;
  state: string;
  zip5: string;
  zip4?: string | null;
  /**
   * Per-recipient unique account number. Plain text, ≤ 20 chars.
   * Required when filing > 250 returns; recommended always so the IRS
   * can disambiguate recipients with similar names.
   */
  accountNumber: string;
  /**
   * Box totals — the type matches IrsFireFile.formType (Form1099NecBoxes
   * for "NE", Form1099MiscBoxes for "MI"). The build loop branches on
   * the file's formType to extract values for the 14 payment slots.
   */
  boxes: Form1099NecBoxes | Form1099MiscBoxes;
}

export interface IrsFireCfsfState {
  /** USPS 2-letter code matching IrsFirePayee.state. */
  state: string;
  /**
   * IRS-assigned numeric Combined Federal/State Filing code, typically
   * 2 digits (e.g. "12" = FL, "06" = CA). See Pub 1220 §G "State
   * Abbreviation Codes." Pass only states approved for CF/SF; the
   * caller is responsible for current participation status.
   */
  cfsfCode: string;
}

export interface IrsFireFile {
  /**
   * 1099 form type — drives the A record's Type of Return field, the
   * Amount Codes mask, and the per-payee slot extraction in B records.
   * Defaults to 'NE' (1099-NEC) when omitted to keep older callers
   * source-compatible.
   */
  formType?: IrsFireFormType;
  transmitter: IrsFireTransmitter;
  payer: IrsFirePayer;
  payees: IrsFirePayee[];
  /**
   * Optional Combined Federal/State Filing list. When present + non-
   * empty, the A record's CF/SF Filer flag flips on, every B record
   * whose state is listed gets the CF/SF code stamped at positions
   * 747-748, and one K record is emitted per state with payees in it
   * (between the C and F records). When omitted/empty, this is a
   * federal-only file — same behavior as before.
   */
  cfsf?: IrsFireCfsfState[];
}

/**
 * IRS Pub 1220 §G "State Abbreviation Codes" — FIPS-derived numeric
 * codes for use in K-record CF/SF and B-record state stamping. Note:
 * not every state participates in Combined Federal/State Filing every
 * year. This table covers all 50 states + DC; the caller is responsible
 * for confirming current-year CF/SF participation before passing a
 * state in the cfsf list. Unparticipating states still need a separate
 * state filing.
 */
export const IRS_CFSF_STATE_CODES: Readonly<Record<string, string>> = Object.freeze({
  AL: '01', AK: '02', AZ: '04', AR: '05', CA: '06', CO: '08', CT: '09',
  DE: '10', DC: '11', FL: '12', GA: '13', HI: '15', ID: '16', IL: '17',
  IN: '18', IA: '19', KS: '20', KY: '21', LA: '22', ME: '23', MD: '24',
  MA: '25', MI: '26', MN: '27', MS: '28', MO: '29', MT: '30', NE: '31',
  NV: '32', NH: '33', NJ: '34', NM: '35', NY: '36', NC: '37', ND: '38',
  OH: '39', OK: '40', OR: '41', PA: '42', RI: '44', SC: '45', SD: '46',
  TN: '47', TX: '48', UT: '49', VT: '50', VA: '51', WA: '53', WV: '54',
  WI: '55', WY: '56',
});

/**
 * Builds the full IRS FIRE file as a single string (CRLF-joined records,
 * no trailing newline). Caller writes it to disk or streams it as the
 * download body — encoding must be ASCII / Windows-1252.
 */
export function buildIrsFireFile(input: IrsFireFile): string {
  const records: string[] = [];
  const formType: IrsFireFormType = input.formType ?? 'NE';

  // CF/SF lookup, normalised to upper-case USPS codes. Pre-validated
  // here so a bad code can't slip into a B/K record positional field.
  const cfsfMap = new Map<string, string>();
  for (const entry of input.cfsf ?? []) {
    if (!/^[A-Z]{2}$/.test(entry.state.toUpperCase())) {
      throw new Error(`IRS FIRE CF/SF state "${entry.state}" must be a 2-letter USPS code`);
    }
    if (!/^\d{1,4}$/.test(entry.cfsfCode)) {
      throw new Error(`IRS FIRE CF/SF code "${entry.cfsfCode}" must be 1-4 digits`);
    }
    cfsfMap.set(entry.state.toUpperCase(), entry.cfsfCode);
  }
  const cfsfActive = cfsfMap.size > 0;

  // Pre-extract per-payee slot arrays. Done up front so we know which
  // slots are populated across the file (drives the Amount Codes mask
  // on the A record) before writing the first B.
  const payeeSlots = input.payees.map((p) =>
    formType === 'NE'
      ? necSlots(p.boxes as Form1099NecBoxes)
      : miscSlots(p.boxes as Form1099MiscBoxes),
  );
  const populatedSlotIdxs = computePopulatedSlots(payeeSlots);
  const amountCodes = populatedSlotIdxs.map((i) => SLOT_CODES[i]).join('');

  // Box-2 / Box-7 checkbox state per payee (NEC: box2DirectSales;
  // MISC: box7DirectSales). Stored at fixed pos 556 in B records.
  const directSalesPerPayee = input.payees.map((p) => {
    if (formType === 'NE') return (p.boxes as Form1099NecBoxes).box2DirectSales;
    return (p.boxes as Form1099MiscBoxes).box7DirectSales;
  });

  records.push(buildT(input.transmitter));
  records.push(buildA(input.payer, input.transmitter.taxYear, cfsfActive, formType, amountCodes));

  // Per-payer totals + per-state totals — both indexed by slot.
  const totals = newPayerTotals();
  const stateTotals = new Map<string, StateTotals>();
  let recordSequence = 1;

  for (let i = 0; i < input.payees.length; i++) {
    const payee = input.payees[i];
    const slots = payeeSlots[i];
    const stateKey = payee.state.toUpperCase();
    const cfsfCode = cfsfMap.get(stateKey) ?? null;

    records.push(
      buildB(
        payee,
        slots,
        directSalesPerPayee[i],
        recordSequence,
        input.transmitter.taxYear,
        cfsfCode,
        formType,
        amountCodes,
      ),
    );
    totals.payeeCount += 1;
    for (let s = 0; s < NUM_AMOUNT_SLOTS; s++) {
      totals.ctrl[s] += slots[s] ?? 0;
    }

    if (cfsfCode) {
      const st = stateTotals.get(stateKey) ?? newStateTotals();
      st.payeeCount += 1;
      for (let s = 0; s < NUM_AMOUNT_SLOTS; s++) {
        st.ctrl[s] += slots[s] ?? 0;
      }
      // State withholding lives on the matched stateLine, not slot 4
      // (which is *federal* backup withholding). K record's "State
      // Income Tax Withheld Total" needs the state slice only.
      const sl = payee.boxes.stateLines.find((l) => l.state.toUpperCase() === stateKey);
      if (sl) st.stateTaxWithheld += sl.stateTaxWithheld;
      stateTotals.set(stateKey, st);
    }
    recordSequence += 1;
  }

  records.push(buildC(totals, recordSequence));
  recordSequence += 1;

  // K records — one per CF/SF state with at least one payee, sorted by
  // state code so the file is byte-stable across re-runs.
  for (const stateKey of [...stateTotals.keys()].sort()) {
    const st = stateTotals.get(stateKey)!;
    const cfsfCode = cfsfMap.get(stateKey)!;
    records.push(buildK(st, cfsfCode, recordSequence));
    recordSequence += 1;
  }

  records.push(buildF({ payeeCount: totals.payeeCount }, recordSequence));

  return records.join('\r\n');
}

/**
 * Slot indices that have a non-null contribution on at least one payee.
 * Drives the Amount Codes mask on the A record and matters for spec
 * compliance — codes for unpopulated slots shouldn't appear.
 */
function computePopulatedSlots(payeeSlots: (number | null)[][]): number[] {
  const populated = new Set<number>();
  for (const slots of payeeSlots) {
    for (let i = 0; i < NUM_AMOUNT_SLOTS; i++) {
      if (slots[i] !== null && slots[i] !== 0) populated.add(i);
    }
  }
  // Always include index 0 (slot 1) so a degenerate all-zero file still
  // produces the minimal "1" code the IRS expects.
  if (populated.size === 0) populated.add(0);
  return [...populated].sort((a, b) => a - b);
}

// ---- Record builders -----------------------------------------------------

function buildT(t: IrsFireTransmitter): string {
  // T TRANSMITTER RECORD — Pub 1220 §B record layout T.
  const fields: Field[] = [
    fixed('T', 1, 1),
    digits(String(t.taxYear), 2, 5),
    blank(6, 6), // Prior Year Data Indicator: blank = current year
    digits(t.ein, 7, 15),
    text(t.tcc, 16, 20),
    blank(21, 27), // Reserved
    blank(28, 28), // Test File Indicator (T = test, blank = production)
    blank(29, 29), // Foreign Entity Indicator
    text(t.name, 30, 69),
    text(t.name, 70, 109), // Transmitter Name (Continuation)
    text('', 110, 149), // Company Name
    text('', 150, 189), // Company Name (Continuation)
    text('', 190, 229), // Company Mailing Address
    text('', 230, 269), // Company City
    text('', 270, 271), // Company State
    text('', 272, 280), // Company ZIP
    blank(281, 295), // Reserved
    digits('00000000', 296, 303), // Total Number of Payees (filled in F record; blank-pad here)
    text(t.contactName, 304, 343),
    text(stripPhone(t.contactPhone), 344, 358),
    text(t.contactEmail, 359, 408),
    blank(409, 499),
    blank(500, 507), // Vendor Indicator + Software fields
    blank(508, 517),
    blank(518, 748),
    blank(749, 750), // Reserved trailer
  ];
  return assemble(fields);
}

function buildA(
  p: IrsFirePayer,
  taxYear: number,
  cfsfActive: boolean,
  formType: IrsFireFormType,
  amountCodes: string,
): string {
  // A PAYER RECORD — opens a payer-EIN block. The Type of Return field
  // ("NE" / "MI") tells the IRS which 1099 vertical this is; the
  // Amount Codes string is a left-justified mask of which payment
  // slots have non-zero values across the file. Position 6 is the
  // Combined Federal/State Filer flag — "1" when at least one K record
  // follows, blank for federal-only files.
  const fields: Field[] = [
    fixed('A', 1, 1),
    digits(String(taxYear), 2, 5),
    text(cfsfActive ? '1' : '', 6, 6), // Combined Federal/State Filer
    blank(7, 11), // Reserved
    blank(12, 16), // Reserved
    digits(p.ein, 17, 25),
    text(p.name, 26, 65),
    blank(66, 66), // Last Filing Indicator: blank = not last
    fixed(formType, 67, 68), // Type of Return: NE = 1099-NEC, MI = 1099-MISC
    text(amountCodes, 69, 84), // Amount Codes — slots with non-zero values
    blank(85, 85), // Reserved
    blank(86, 86), // Foreign Entity Indicator
    text(p.name, 87, 126), // Payer Name (Cont)
    text('', 127, 166), // Transfer Agent Name
    text(p.addressLine1, 167, 206),
    text(p.city, 207, 246),
    text(p.state, 247, 248),
    digits(p.zip5, 249, 253),
    text(p.zip4 ?? '', 254, 257),
    text(stripPhone(''), 258, 272), // Payer Phone (optional, blank ok)
    blank(273, 499),
    digits('00000000', 500, 507), // Reserved-record-sequence; F record carries the real one
    blank(508, 748),
    blank(749, 750),
  ];
  return assemble(fields);
}

function buildB(
  p: IrsFirePayee,
  slots: (number | null)[],
  directSales: boolean,
  sequence: number,
  taxYear: number,
  cfsfCode: string | null,
  formType: IrsFireFormType,
  amountCodes: string,
): string {
  // B PAYEE RECORD — one per 1099. The amount fields live at fixed
  // positions per the Type of Return; the slot map (necSlots /
  // miscSlots) extracts the right Box for each of the 14 payment slots
  // for this form. Unused slots are zeroed. Money fields are 12 chars
  // zero-padded in cents (NOT 11 like EFW2). Negative payments are
  // encoded by flipping the rightmost digit's sign-overpunch byte —
  // out of scope here; IRS rejects negatives on 1099 anyway. Position
  // 556 is the "Direct Sales" checkbox — Box 2 for NEC, Box 7 for MISC.
  const fields: Field[] = [
    fixed('B', 1, 1),
    digits(String(taxYear), 2, 5),
    blank(6, 6), // Corrected Return Indicator (G/C/blank)
    text('', 7, 10), // Name Control (auto-derived from name; IRS recomputes)
    text(p.tinTypeCode, 11, 11),
    digits(p.tin, 12, 20),
    text(p.accountNumber, 21, 40),
    blank(41, 44), // Office Code
    blank(45, 54), // Reserved + Payee Reserved
    money(slots[0] ?? 0, 55, 66),   // Payment Amount 1
    money(slots[1] ?? 0, 67, 78),   // Payment Amount 2
    money(slots[2] ?? 0, 79, 90),   // Payment Amount 3
    money(slots[3] ?? 0, 91, 102),  // Payment Amount 4
    money(slots[4] ?? 0, 103, 114), // Payment Amount 5
    money(slots[5] ?? 0, 115, 126), // Payment Amount 6
    money(slots[6] ?? 0, 127, 138), // Payment Amount 7
    money(slots[7] ?? 0, 139, 150), // Payment Amount 8
    money(slots[8] ?? 0, 151, 162), // Payment Amount 9
    money(slots[9] ?? 0, 163, 174), // Payment Amount A (10)
    money(slots[10] ?? 0, 175, 186), // Payment Amount B (11)
    money(slots[11] ?? 0, 187, 198), // Payment Amount C (12)
    money(slots[12] ?? 0, 199, 210), // Payment Amount D (13)
    money(slots[13] ?? 0, 211, 222), // Payment Amount E (14)
    blank(223, 246), // Reserved
    text('', 247, 247), // Foreign Country Indicator
    text(p.name, 248, 287), // Payee Name Line 1
    text('', 288, 327), // Payee Name Line 2
    text(p.addressLine1, 328, 367),
    text(p.city, 368, 407),
    text(p.state, 408, 409),
    digits(p.zip5, 410, 414),
    text(p.zip4 ?? '', 415, 418),
    blank(419, 543), // Reserved
    blank(544, 547), // Second TIN Notice (blank = none)
    blank(548, 555),
    text(directSales ? '1' : '2', 556, 556), // Direct Sales: '1'=true, '2'=false (NEC Box 2 / MISC Box 7)
    blank(557, 662),
    blank(663, 664),
    digits(String(sequence).padStart(8, '0'), 665, 672), // Record Sequence Number
    blank(673, 707),
    text(formType, 708, 709), // Type of Return — re-stated for some validators
    text(amountCodes, 710, 725), // Amount Codes — re-stated
    blank(726, 746),
    text(cfsfCode ?? '', 747, 748), // Combined Federal/State Code (CF/SF only)
    blank(749, 750),
  ];
  return assemble(fields);
}

interface PayerTotals {
  payeeCount: number;
  /** 14 control totals indexed by slot (0 = slot 1, …, 13 = slot E). */
  ctrl: number[];
}

function newPayerTotals(): PayerTotals {
  return { payeeCount: 0, ctrl: new Array(NUM_AMOUNT_SLOTS).fill(0) };
}

function buildC(totals: PayerTotals, sequence: number): string {
  // C END-OF-PAYER RECORD — closes the A block. Sums every B record's
  // payment amounts (per slot). Counts must match what the IRS parses
  // on its end; mismatch rejects the file. Pub 1220 widens the totals
  // to 18-char dollars+cents (vs 12-char on B records).
  const fields: Field[] = [
    fixed('C', 1, 1),
    digits(String(totals.payeeCount).padStart(8, '0'), 2, 9),
    blank(10, 15),
    money(totals.ctrl[0],  16, 33),  // Control Total 1
    money(totals.ctrl[1],  34, 51),  // Control Total 2
    money(totals.ctrl[2],  52, 69),  // Control Total 3
    money(totals.ctrl[3],  70, 87),  // Control Total 4
    money(totals.ctrl[4],  88, 105), // Control Total 5
    money(totals.ctrl[5], 106, 123), // Control Total 6
    money(totals.ctrl[6], 124, 141), // Control Total 7
    money(totals.ctrl[7], 142, 159), // Control Total 8
    money(totals.ctrl[8], 160, 177), // Control Total 9
    money(totals.ctrl[9], 178, 195), // Control Total A (10)
    money(totals.ctrl[10], 196, 213), // Control Total B (11)
    money(totals.ctrl[11], 214, 231), // Control Total C (12)
    money(totals.ctrl[12], 232, 249), // Control Total D (13)
    // NOTE: Slot E (14) doesn't get its own control total at this
    // record width per Pub 1220's C-record layout — it'd push past
    // pos 250 into the reserved block. Trail accumulates correctly
    // for K records below; per-payer file totals exclude slot E.
    blank(250, 499),
    digits(String(sequence).padStart(8, '0'), 500, 507),
    blank(508, 748),
    blank(749, 750),
  ];
  return assemble(fields);
}

interface StateTotals {
  payeeCount: number;
  /** 14 control totals indexed by slot. */
  ctrl: number[];
  stateTaxWithheld: number;
}

function newStateTotals(): StateTotals {
  return { payeeCount: 0, ctrl: new Array(NUM_AMOUNT_SLOTS).fill(0), stateTaxWithheld: 0 };
}

function buildK(state: StateTotals, cfsfCode: string, sequence: number): string {
  // K STATE TOTALS RECORD — emitted once per CF/SF participating state
  // between the C and F records. Same Control-Total layout (positions
  // 16-249) as the C record, but the trailer (707-746) carries state-
  // specific totals: state tax withheld, local tax withheld (we don't
  // track local — zero), and the IRS CF/SF state code right-justified
  // in a 4-char field. Sequence number is part of the file-wide chain
  // so K records show up between C (last B in payer block) and F.
  const fields: Field[] = [
    fixed('K', 1, 1),
    digits(String(state.payeeCount).padStart(8, '0'), 2, 9),
    blank(10, 15),
    money(state.ctrl[0],  16, 33),  // Control Total 1
    money(state.ctrl[1],  34, 51),  // Control Total 2
    money(state.ctrl[2],  52, 69),  // Control Total 3
    money(state.ctrl[3],  70, 87),  // Control Total 4
    money(state.ctrl[4],  88, 105), // Control Total 5
    money(state.ctrl[5], 106, 123), // Control Total 6
    money(state.ctrl[6], 124, 141), // Control Total 7
    money(state.ctrl[7], 142, 159), // Control Total 8
    money(state.ctrl[8], 160, 177), // Control Total 9
    money(state.ctrl[9], 178, 195), // Control Total A (10)
    money(state.ctrl[10], 196, 213), // Control Total B (11)
    money(state.ctrl[11], 214, 231), // Control Total C (12)
    money(state.ctrl[12], 232, 249), // Control Total D (13)
    blank(250, 499),
    digits(String(sequence).padStart(8, '0'), 500, 507),
    blank(508, 706),
    money(state.stateTaxWithheld, 707, 724), // State Income Tax Withheld Total
    money(0, 725, 742), // Local Income Tax Withheld Total (we don't track)
    digits(cfsfCode.padStart(4, '0'), 743, 746), // CF/SF Code, right-justified
    blank(747, 748),
    blank(749, 750),
  ];
  return assemble(fields);
}

function buildF(input: { payeeCount: number }, sequence: number): string {
  // F END-OF-FILE RECORD — final record. Carries the grand total of B
  // records across every A block in the file (we have one A block).
  const fields: Field[] = [
    fixed('F', 1, 1),
    digits(String(input.payeeCount).padStart(8, '0'), 2, 9),
    blank(10, 21), // Zero-padded reserved
    blank(22, 499),
    digits(String(sequence).padStart(8, '0'), 500, 507),
    blank(508, 748),
    blank(749, 750),
  ];
  return assemble(fields);
}

// ---- Field primitives ----------------------------------------------------

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
  const cleaned = ascii(raw);
  return { start, end, value: cleaned.slice(0, len).padEnd(len, ' ') };
}

function digits(raw: string, start: number, end: number): Field {
  const len = end - start + 1;
  if (!/^\d+$/.test(raw)) {
    throw new Error(`digits value "${raw}" has non-numeric characters (${start}-${end})`);
  }
  return { start, end, value: raw.slice(0, len).padStart(len, '0') };
}

function blank(start: number, end: number): Field {
  const len = end - start + 1;
  return { start, end, value: ' '.repeat(len) };
}

/**
 * Money in CENTS, zero-padded. IRS Pub 1220 disallows negative amounts
 * on 1099-NEC; we floor at 0.
 */
function money(amount: number, start: number, end: number): Field {
  const len = end - start + 1;
  const cents = Math.max(0, Math.round(amount * 100));
  const str = String(cents);
  if (str.length > len) {
    throw new Error(`money ${amount} (${cents}¢) exceeds field width ${len} (${start}-${end})`);
  }
  return { start, end, value: str.padStart(len, '0') };
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

/**
 * Sorts fields by start position, asserts no gaps and no overlaps, and
 * concatenates into the final 750-char record. Catches positional bugs
 * at build time rather than at IRS-rejection time.
 */
function assemble(fields: Field[]): string {
  const sorted = [...fields].sort((a, b) => a.start - b.start);
  let cursor = 1;
  const parts: string[] = [];
  for (const f of sorted) {
    if (f.start !== cursor) {
      throw new Error(
        `IRS FIRE record gap or overlap: field ${f.start}-${f.end} expected to start at ${cursor}`,
      );
    }
    parts.push(f.value);
    cursor = f.end + 1;
  }
  if (cursor !== RECORD_LEN + 1) {
    throw new Error(
      `IRS FIRE record length ${cursor - 1} ≠ ${RECORD_LEN}; missing trailing field?`,
    );
  }
  const line = parts.join('');
  if (line.length !== RECORD_LEN) {
    throw new Error(`IRS FIRE record assembled to ${line.length} chars, expected ${RECORD_LEN}`);
  }
  return line;
}
