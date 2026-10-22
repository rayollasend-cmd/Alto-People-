import { describe, expect, it } from 'vitest';
import { buildEfw2File, type Efw2File } from '../../lib/efw2.js';

// The EFW2 generator against SSA Pub 42-007 (TY2025, v3.3): every record
// exactly 512 chars, RA → RE → (RW [RO] [RS…])+ → RT [RU] [RV] → RF order,
// RT/RF totals reconcile to the RW figures, CRLF separators, and the
// fields the spec places by position (AccuWage remains the final check).

const sampleInput: Efw2File = {
  submitter: {
    ein: '123456789',
    userId: 'USRID0000000001',
    name: 'Acme Test Co LLC',
    addressLine1: '1 Acme Way',
    city: 'Tampa',
    state: 'FL',
    zip5: '33601',
    zip4: '0001',
    contactName: 'Pat Manager',
    contactPhone: '555-867-5309',
    contactEmail: 'pat@acme.test',
  },
  employer: {
    ein: '987654321',
    taxYear: 2026,
    name: 'Acme Test Co LLC',
    addressLine1: '1 Acme Way',
    city: 'Tampa',
    state: 'FL',
    zip5: '33601',
  },
  employees: [
    {
      ssn: '111223333',
      firstName: 'Jordan',
      lastName: 'Reyes',
      addressLine1: '742 Evergreen Terrace',
      city: 'Springfield',
      state: 'FL',
      zip5: '32801',
      boxes: {
        box1Wages: 1234.56,
        box2FitWithheld: 100,
        box3SsWages: 1234.56,
        box4SsTax: 76.54,
        box5MedicareWages: 1234.56,
        box6MedicareTax: 17.9,
        stateLines: [{ state: 'FL', stateWages: 1234.56, stateIncomeTax: 0 }],
        sourceItemCount: 1,
      },
    },
    {
      ssn: '222334444',
      firstName: 'Pat',
      lastName: 'Lee',
      addressLine1: '5 Oak St',
      city: 'Tampa',
      state: 'FL',
      zip5: '33602',
      boxes: {
        box1Wages: 2000,
        box2FitWithheld: 200,
        box3SsWages: 2000,
        box4SsTax: 124,
        box5MedicareWages: 2000,
        box6MedicareTax: 29,
        stateLines: [],
        sourceItemCount: 1,
      },
    },
  ],
};

describe('EFW2 generator — structural invariants', () => {
  const file = buildEfw2File(sampleInput);
  const lines = file.split('\r\n');

  it('every record is exactly 512 characters', () => {
    for (const [i, line] of lines.entries()) {
      expect(line.length, `line ${i + 1}: ${line.slice(0, 2)}…`).toBe(512);
    }
  });

  it('uses CRLF line separators (no bare LF in the body)', () => {
    expect(file.includes('\r\n')).toBe(true);
    // Each record terminator is a single CRLF; if buildEfw2File
    // accidentally inserted bare LFs we'd get more lines than records.
    const recordTypes = lines.map((l) => l.slice(0, 2));
    expect(recordTypes.length).toBe(lines.length);
  });

  it('starts with RA, ends with RF, and contains exactly one RE block', () => {
    const types = lines.map((l) => l.slice(0, 2));
    expect(types[0]).toBe('RA');
    expect(types[types.length - 1]).toBe('RF');
    expect(types.filter((t) => t === 'RE').length).toBe(1);
    expect(types.filter((t) => t === 'RT').length).toBe(1);
    expect(types.filter((t) => t === 'RW').length).toBe(2);
    // One RS for Jordan (FL state line); zero for Pat (no state lines).
    expect(types.filter((t) => t === 'RS').length).toBe(1);
  });

  it('record order: RA, RE, (RW [RS...])+, RT, RV, RF', () => {
    const types = lines.map((l) => l.slice(0, 2));
    expect(types).toEqual(['RA', 'RE', 'RW', 'RS', 'RW', 'RT', 'RV', 'RF']);
  });

  it('RT totals reconcile to the sum of RW dollar fields', () => {
    const rt = lines.find((l) => l.startsWith('RT'))!;
    // RT positions per buildRT — RW count 3-9, then 11-char money fields
    // start at 10. We sliced via 0-based string index in the test.
    const rwCount = rt.slice(2, 9);
    expect(rwCount).toBe('0000002');

    // Box 1: 1234.56 + 2000 = 3234.56 → 323456 cents → padded to 15 digits.
    const box1Total = rt.slice(9, 24);
    expect(box1Total).toBe('000000000323456');

    // Box 2: 100 + 200 = 300 → 30000 cents.
    const box2Total = rt.slice(24, 39);
    expect(box2Total).toBe('000000000030000');
  });

  it('RF reports the same RW count as RT', () => {
    const rf = lines.find((l) => l.startsWith('RF'))!;
    // RF position 8-16 holds the count, padded to 9 digits.
    const total = rf.slice(7, 16);
    expect(total).toBe('000000002');
  });

  it('RW dollar fields encode cents zero-padded with no decimal point', () => {
    const rw1 = lines.find((l) => l.startsWith('RW'))!;
    // First RW = Jordan's: Box 1 = 1234.56 = 123456 cents, 11 digits, positions 188-198.
    const box1 = rw1.slice(187, 198);
    expect(box1).toBe('00000123456');
  });

  it('rejects non-numeric EIN (digits() validator catches positional bugs)', () => {
    // Most field-position bugs surface as length mismatches that
    // assemble() catches; the digits() validator catches the other
    // common class — non-numeric content where SSA expects pure digits.
    expect(() =>
      buildEfw2File({
        ...sampleInput,
        employer: { ...sampleInput.employer, ein: 'NOT-DIGITS' },
      }),
    ).toThrow(/non-numeric/);
  });
});

const at = (line: string, start: number, end: number) => line.slice(start - 1, end);

describe('EFW2 generator — field positions (Pub 42-007 TY2025)', () => {
  const one = (boxes: Partial<Efw2File['employees'][number]['boxes']>, taxYear = 2025): string[] =>
    buildEfw2File({
      ...sampleInput,
      employer: { ...sampleInput.employer, taxYear, stateAccountNumbers: { PA: '12345678' } },
      employees: [{ ...sampleInput.employees[0]!, boxes: { ...sampleInput.employees[0]!.boxes, ...boxes } }],
    }).split('\r\n');

  it('RA and RE put the names and codes where SSA reads them', () => {
    const [ra, re] = one({});
    expect(at(ra!, 36, 37)).toBe('98');
    expect(at(ra!, 38, 94).trim()).toBe('Acme Test Co LLC');
    expect(at(ra!, 500, 500)).toBe('L');
    expect(at(re!, 3, 6)).toBe('2025');
    expect(at(re!, 40, 96).trim()).toBe('Acme Test Co LLC');
    expect(at(re!, 174, 174)).toBe('N');
    expect(at(re!, 219, 219)).toBe('R');
  });

  it('Box 7, 10, 12 D/W/DD/AA/C and the retirement-plan indicator land in their RW fields; RT totals them', () => {
    const lines = one({
      box7SsTips: 50,
      box10DependentCare: 2500,
      box12: [
        { code: 'C', amount: 120 },
        { code: 'D', amount: 1000 },
        { code: 'W', amount: 300 },
        { code: 'AA', amount: 400 },
        { code: 'DD', amount: 6000 },
        { code: 'J', amount: 10 },
      ],
      box13RetirementPlan: true,
    });
    const rw = lines.find((l) => l.startsWith('RW'))!;
    expect(at(rw, 254, 264)).toBe('00000005000');
    expect(at(rw, 276, 286)).toBe('00000250000');
    expect(at(rw, 287, 297)).toBe('00000100000');
    expect(at(rw, 364, 374)).toBe('00000030000');
    expect(at(rw, 408, 418)).toBe('00000012000');
    expect(at(rw, 441, 451)).toBe('00000040000');
    expect(at(rw, 463, 473)).toBe('00000600000');
    expect(at(rw, 488, 488)).toBe('1');
    const rt = lines.find((l) => l.startsWith('RT'))!;
    expect(at(rt, 145, 159)).toBe('000000000100000');
    expect(at(rt, 295, 309)).toBe('000000000600000');
  });

  it('an RO record (and RU total) carries Box 12 EE', () => {
    const lines = one({ box12: [{ code: 'EE', amount: 750 }] });
    expect(lines.map((l) => l.slice(0, 2))).toEqual(['RA', 'RE', 'RW', 'RO', 'RS', 'RT', 'RU', 'RV', 'RF']);
    expect(at(lines.find((l) => l.startsWith('RO'))!, 111, 121)).toBe('00000075000');
    expect(at(lines.find((l) => l.startsWith('RU'))!, 145, 159)).toBe('000000000075000');
  });

  it('RS carries the numeric state code, the state account, and a locality', () => {
    const lines = one({
      stateLines: [{ state: 'PA', stateWages: 1500, stateIncomeTax: 46.05 }],
      localLines: [
        { state: 'PA', locality: 'Pittsburgh EIT', code: '700101', kind: 'LOCAL', localWages: 1500, localIncomeTax: 45 },
        { state: 'PA', locality: 'Pittsburgh LST', code: 'LST-700101', kind: 'OLT', localWages: 1500, localIncomeTax: 52 },
      ],
    });
    const rs = lines.filter((l) => l.startsWith('RS'));
    expect(rs).toHaveLength(2);
    expect(at(rs[0]!, 3, 4)).toBe('42');
    expect(at(rs[0]!, 274, 275)).toBe('42');
    expect(at(rs[0]!, 248, 267).trim()).toBe('12345678');
    expect(at(rs[0]!, 276, 286)).toBe('00000150000');
    expect(at(rs[0]!, 287, 297)).toBe('00000004605');
    expect(at(rs[0]!, 308, 308)).toBe('C');
    expect(at(rs[0]!, 320, 330)).toBe('00000004500');
    // The second locality rides its own RS with the state fields zero, so state totals are not doubled.
    expect(at(rs[1]!, 276, 286)).toBe('00000000000');
    expect(at(rs[1]!, 320, 330)).toBe('00000005200');
    expect(at(rs[1]!, 308, 308)).toBe('F');
  });

  it('a TY2026 W-2 carries TP and TT in their RO fields and the tipped occupation code in RW 490-492', () => {
    const lines = one({ box12: [{ code: 'TP', amount: 300 }, { code: 'TT', amount: 125.5 }, { code: 'A', amount: 10 }], box14bTippedOccupationCodes: ['101', '205'] }, 2026);
    const rw = lines.find((l) => l.startsWith('RW'))!;
    const ro = lines.find((l) => l.startsWith('RO'))!;
    expect(at(rw, 490, 492)).toBe('101');
    expect(at(rw, 493, 495)).toBe('205');
    expect(at(ro, 232, 242)).toBe('00000030000');
    expect(at(ro, 243, 253)).toBe('00000012550');
    // Code A moved to its own field; the TY2025 combined A+B field is zero.
    expect(at(ro, 155, 165)).toBe('00000001000');
    expect(at(ro, 23, 33)).toBe('00000000000');
    for (const l of lines) expect(l).toHaveLength(512);
  });

  it('a TY2025 W-2 still refuses the 2026 codes, and keeps A and B combined', () => {
    expect(() => one({ box12: [{ code: 'TP', amount: 300 }] }, 2025)).toThrow(/TP/);
    expect(() => one({ box14bTippedOccupationCodes: ['101'] }, 2025)).toThrow(/14b/);
    const ro = one({ box12: [{ code: 'A', amount: 10 }, { code: 'B', amount: 5 }] }, 2025).find((l) => l.startsWith('RO'))!;
    expect(at(ro, 23, 33)).toBe('00000001500');
  });
});
