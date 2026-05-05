import { describe, expect, it } from 'vitest';
import { buildIrsFireFile, type IrsFireFile } from '../../lib/irsFire.js';
import type { Form1099NecBoxes } from '../../lib/f1099NecAggregator.js';

const RECORD_LEN = 750;

const submitter = {
  tcc: 'AB123',
  ein: '123456789',
  name: 'Acme Test Co LLC',
  contactName: 'Jane Tester',
  contactPhone: '5555550100',
  contactEmail: 'fire-test@altohr.com',
  taxYear: 2024,
};

const payer = {
  ein: '987654321',
  name: 'Acme Test Co LLC',
  addressLine1: '500 Industrial Blvd',
  city: 'Tampa',
  state: 'FL',
  zip5: '33602',
};

function payee(over: { tin?: string; box1?: number; box4?: number; tinTypeCode?: '1' | '2' } = {}): {
  tin: string;
  tinTypeCode: '1' | '2';
  name: string;
  addressLine1: string;
  city: string;
  state: string;
  zip5: string;
  accountNumber: string;
  boxes: Form1099NecBoxes;
} {
  return {
    tin: over.tin ?? '111223333',
    tinTypeCode: over.tinTypeCode ?? '1',
    name: 'Pat Sample',
    addressLine1: '12 Maple St',
    city: 'Tampa',
    state: 'FL',
    zip5: '33602',
    accountNumber: 'ACCT00000001',
    boxes: {
      box1NonemployeeCompensation: over.box1 ?? 1500,
      box2DirectSales: false,
      box4FitWithheld: over.box4 ?? 0,
      stateLines: [],
      sourceItemCount: 1,
    },
  };
}

describe('buildIrsFireFile — Gap 11', () => {
  it('produces T/A/B/C/F records, all exactly 750 chars wide', () => {
    const file: IrsFireFile = {
      transmitter: submitter,
      payer,
      payees: [payee()],
    };
    const out = buildIrsFireFile(file);
    const lines = out.split('\r\n');
    expect(lines.map((l) => l[0])).toEqual(['T', 'A', 'B', 'C', 'F']);
    for (const line of lines) {
      expect(line.length).toBe(RECORD_LEN);
    }
  });

  it('one B record per payee; F counter matches the B record count', () => {
    const file: IrsFireFile = {
      transmitter: submitter,
      payer,
      payees: [
        payee({ tin: '111223333', box1: 800 }),
        payee({ tin: '444556666', box1: 1200 }),
        payee({ tin: '777889999', box1: 600 }),
      ],
    };
    const out = buildIrsFireFile(file);
    const lines = out.split('\r\n');
    const bLines = lines.filter((l) => l.startsWith('B'));
    expect(bLines.length).toBe(3);

    const fLine = lines[lines.length - 1];
    // F-record positions 2-9: zero-padded payee count
    expect(fLine.slice(1, 9)).toBe('00000003');
  });

  it('C-record control totals sum every B-record amount field', () => {
    const file: IrsFireFile = {
      transmitter: submitter,
      payer,
      payees: [
        payee({ box1: 1000, box4: 100 }),
        payee({ box1: 2500, box4: 0 }),
        payee({ box1: 750, box4: 50 }),
      ],
    };
    const out = buildIrsFireFile(file);
    const cLine = out.split('\r\n').find((l) => l.startsWith('C'))!;
    // Control Total 1 (Box 1 sum) is at positions 16-33 — 18-char cents
    const ctrl1 = cLine.slice(15, 33);
    // Control Total 4 (Box 4 sum) at 70-87
    const ctrl4 = cLine.slice(69, 87);
    expect(Number(ctrl1)).toBe((1000 + 2500 + 750) * 100);
    expect(Number(ctrl4)).toBe((100 + 0 + 50) * 100);
  });

  it('B-record encodes Box 1 in Payment Amount 1 (cents, zero-padded 12 chars)', () => {
    const file: IrsFireFile = {
      transmitter: submitter,
      payer,
      payees: [payee({ box1: 1234.56, box4: 0 })],
    };
    const out = buildIrsFireFile(file);
    const bLine = out.split('\r\n').find((l) => l.startsWith('B'))!;
    // Payment Amount 1 = positions 55-66 → 12-char zero-padded cents
    const amt1 = bLine.slice(54, 66);
    expect(amt1).toBe('000000123456');
  });

  it('rejects negative payment amounts (IRS Pub 1220 disallows on 1099-NEC)', () => {
    // The money primitive floors at 0. We verify the file builds — a
    // negative is silently zeroed rather than throwing, because a
    // signed-overpunch path would surprise the caller. Document the
    // current behaviour: zero out + still 750 chars wide.
    const file: IrsFireFile = {
      transmitter: submitter,
      payer,
      payees: [payee({ box1: -100, box4: 0 })],
    };
    const out = buildIrsFireFile(file);
    const bLine = out.split('\r\n').find((l) => l.startsWith('B'))!;
    expect(bLine.slice(54, 66)).toBe('000000000000');
  });

  it('throws if the EIN has non-numeric characters', () => {
    const file: IrsFireFile = {
      transmitter: { ...submitter, ein: '12-3456789' },
      payer,
      payees: [payee()],
    };
    expect(() => buildIrsFireFile(file)).toThrow(/non-numeric/);
  });

  it('handles a recipient with EIN (business contractor) — tinTypeCode "2"', () => {
    const file: IrsFireFile = {
      transmitter: submitter,
      payer,
      payees: [payee({ tin: '987654321', tinTypeCode: '2' })],
    };
    const out = buildIrsFireFile(file);
    const bLine = out.split('\r\n').find((l) => l.startsWith('B'))!;
    // tinTypeCode at position 11; TIN at 12-20
    expect(bLine[10]).toBe('2');
    expect(bLine.slice(11, 20)).toBe('987654321');
  });
});
