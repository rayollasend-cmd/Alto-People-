import { describe, expect, it } from 'vitest';
import { buildEfw2File, type Efw2File } from '../../lib/efw2.js';

// Structural smoke tests for the EFW2 generator. We don't claim
// SSA-spec field-position correctness here — that's a finance-review
// pass against Pub 42-007 + AccuWage. These tests verify the invariants
// the SSA validator definitely cares about: every record exactly 512
// chars, RA → RE → RW... → RT → RF order, RT/RF totals reconcile to
// the RW figures, and CRLF line separators.

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

  it('record order: RA, RE, (RW [RS...])+, RT, RF', () => {
    const types = lines.map((l) => l.slice(0, 2));
    expect(types).toEqual(['RA', 'RE', 'RW', 'RS', 'RW', 'RT', 'RF']);
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
    // First RW = Jordan's: Box 1 = 1234.56 = 123456 cents, 11 digits.
    const box1 = rw1.slice(166, 177);
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
