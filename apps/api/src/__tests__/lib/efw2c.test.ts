import { describe, expect, it } from 'vitest';
import { buildEfw2cFile, type Efw2cFile } from '../../lib/efw2c.js';

// Structural smoke tests for the EFW2C generator. Same scope as the
// EFW2 tests: 512-char records, RCA→RCF order, totals reconcile to
// per-RCW deltas, signed-money for negatives. Field-position
// correctness is a finance-review pass against SSA Pub 42-014.

const sampleInput: Efw2cFile = {
  submitter: {
    ein: '123456789',
    userId: 'USRID0000000001',
    name: 'Acme Test Co LLC',
    addressLine1: '1 Acme Way',
    city: 'Tampa',
    state: 'FL',
    zip5: '33601',
    contactName: 'Pat Manager',
    contactPhone: '5558675309',
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
      previous: {
        box1Wages: 1000,
        box2FitWithheld: 100,
        box3SsWages: 1000,
        box4SsTax: 62,
        box5MedicareWages: 1000,
        box6MedicareTax: 14.5,
        stateLines: [],
        sourceItemCount: 1,
      },
      corrected: {
        box1Wages: 1100, // +100
        box2FitWithheld: 110, // +10
        box3SsWages: 1100, // +100
        box4SsTax: 68.2, // +6.20
        box5MedicareWages: 1100, // +100
        box6MedicareTax: 15.95, // +1.45
        stateLines: [],
        sourceItemCount: 2,
      },
    },
    {
      // Negative-delta correction (employee was overpaid; W-2c claws back).
      ssn: '222334444',
      firstName: 'Pat',
      lastName: 'Lee',
      addressLine1: '5 Oak St',
      city: 'Tampa',
      state: 'FL',
      zip5: '33602',
      previous: {
        box1Wages: 2000,
        box2FitWithheld: 200,
        box3SsWages: 2000,
        box4SsTax: 124,
        box5MedicareWages: 2000,
        box6MedicareTax: 29,
        stateLines: [],
        sourceItemCount: 1,
      },
      corrected: {
        box1Wages: 1900, // -100
        box2FitWithheld: 190, // -10
        box3SsWages: 1900,
        box4SsTax: 117.8, // -6.20
        box5MedicareWages: 1900,
        box6MedicareTax: 27.55, // -1.45
        stateLines: [],
        sourceItemCount: 1,
      },
    },
  ],
};

describe('EFW2C generator — structural invariants', () => {
  const file = buildEfw2cFile(sampleInput);
  const lines = file.split('\r\n');

  it('every record is exactly 512 characters', () => {
    for (const [i, line] of lines.entries()) {
      expect(line.length, `line ${i + 1}: ${line.slice(0, 3)}…`).toBe(512);
    }
  });

  it('records use 3-char RC* prefixes and are in RCA → RCE → RCW… → RCT → RCF order', () => {
    const types = lines.map((l) => l.slice(0, 3));
    expect(types[0]).toBe('RCA');
    expect(types[types.length - 1]).toBe('RCF');
    expect(types).toEqual(['RCA', 'RCE', 'RCW', 'RCW', 'RCT', 'RCF']);
  });

  it('RCT carries the SUM of (corrected - previous) per box across RCWs', () => {
    const rct = lines.find((l) => l.startsWith('RCT'))!;
    // Width: RCT 1-3, count 4-10, then 6 signedMoney fields of 15 chars each starting at 11.
    const count = rct.slice(3, 10);
    expect(count).toBe('0000002');

    // Net Box 1 delta: +100 + (-100) = 0
    const dBox1 = rct.slice(10, 25);
    expect(dBox1).toBe('000000000000000');

    // Net Box 2 delta: +10 + (-10) = 0
    const dBox2 = rct.slice(25, 40);
    expect(dBox2).toBe('000000000000000');

    // Net Box 4 delta: +6.20 + (-6.20) = 0 (or possibly close to it
    // depending on cent rounding). Round trip via cents avoids float drift.
    const dBox4 = rct.slice(55, 70);
    expect(dBox4).toBe('000000000000000');
  });

  it('signedMoney handles negative deltas correctly when totals are not zero', () => {
    // Build an unbalanced file (only the negative employee) so RCT goes
    // negative and we can exercise the signed-leading-minus path.
    const unbalanced: Efw2cFile = {
      ...sampleInput,
      employees: [sampleInput.employees[1]], // Pat Lee with -100 box1 delta
    };
    const out = buildEfw2cFile(unbalanced);
    const rct = out.split('\r\n').find((l) => l.startsWith('RCT'))!;
    const dBox1 = rct.slice(10, 25);
    // Expected: -10000 cents = "-000000000010000" — leading dash, 14 zeros, then 10000.
    expect(dBox1.startsWith('-')).toBe(true);
    expect(parseInt(dBox1.slice(1), 10)).toBe(10000);
  });

  it('RCF carries the same RCW count as RCT', () => {
    const rcf = lines.find((l) => l.startsWith('RCF'))!;
    // RCF position 9-17 holds the count, padded to 9 digits.
    const total = rcf.slice(8, 17);
    expect(total).toBe('000000002');
  });

  it('RCW carries previous + corrected box1 as adjacent 11-char cents fields', () => {
    const rcw1 = lines.find((l) => l.startsWith('RCW'))!;
    // First RCW = Jordan: prev box1 = 1000 = 100000 cents; curr = 1100 = 110000 cents.
    // Positions 168-178 (prev) and 179-189 (curr); 0-based string index = 167..189.
    const prev = rcw1.slice(167, 178);
    const curr = rcw1.slice(178, 189);
    expect(prev).toBe('00000100000');
    expect(curr).toBe('00000110000');
  });

  it('rejects non-numeric EIN (digits validator)', () => {
    expect(() =>
      buildEfw2cFile({
        ...sampleInput,
        employer: { ...sampleInput.employer, ein: 'NOT-DIGITS' },
      }),
    ).toThrow(/non-numeric/);
  });
});
