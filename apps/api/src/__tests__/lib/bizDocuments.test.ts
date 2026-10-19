import { describe, expect, it } from 'vitest';
import { remittanceStub, invoiceLabel, periodLabel, renderStatementPdf } from '../../lib/statementPdf.js';
import { packetSections, packetFingerprint, renderCompliancePacket, type PacketData } from '../../lib/compliancePacket.js';
import { certificateRows, renderSignedAgreement } from '../../lib/esign.js';
import { renderLetterPdf } from '../../lib/letterPdf.js';
import { fmt } from '../../lib/docKit/index.js';

/** Business documents in the house style: the invoice stub, the packet's contents, the e-sign certificate. */

const snapshot = {
  clientName: 'Coastal Resort Holdings',
  periodStart: '2026-09-26',
  periodEnd: '2026-10-09',
  lines: [{ label: 'Housekeeper — regular', hours: 40, rate: 24, amount: 960 }],
  stores: [],
  totals: { hours: 40, regularHours: 40, otHours: 0, amount: 960 },
  sla: { publishedShifts: 5, assignedShifts: 5, fillRatePct: 100, punctualPct: 100, noShows: 0, pendingEntries: 0 },
};
const base = { snapshot, number: 27, status: 'FINAL', finalizedAt: new Date('2026-10-12T15:00:00Z'), billTo: { legalName: 'Coastal Resort Holdings, LLC', addressLine1: null, addressLine2: null, city: null, state: null, zip: null }, remitTo: { name: 'Alto HR Staffing, Inc.', lines: ['PO Box 9921'] }, dueDate: new Date('2026-11-11T12:00:00Z') };

describe('the invoice', () => {
  it('the remittance stub carries who to pay, the invoice, the due date and the amount', () => {
    expect(remittanceStub(base as never)).toEqual({ payTo: 'Alto HR Staffing, Inc.', customer: 'Coastal Resort Holdings, LLC', invoice: 'Invoice No. 0027', dueDate: 'Nov 11, 2026', amountDue: '$960.00', paid: false });
    expect(remittanceStub({ ...base, paidAt: new Date() } as never)).toMatchObject({ amountDue: '$0.00', paid: true });
    expect(invoiceLabel('DRAFT', null)).toBe('Draft statement');
    expect(periodLabel('2026-09-26', '2026-10-09')).toBe('Sep 26 – Oct 9, 2026');
  });

  it('renders final, paid, draft and a snapshot missing its fields', async () => {
    for (const input of [base, { ...base, paidAt: new Date('2026-10-14T12:00:00Z') }, { ...base, status: 'DRAFT', number: null }, { ...base, snapshot: { totals: { hours: 1, amount: 10 } } }]) {
      const pdf = await renderStatementPdf(input as never);
      expect(pdf.subarray(0, 5).toString()).toBe('%PDF-');
    }
  });
});

describe('formatting rules', () => {
  it('never prints -$0.00, uses a true minus, and reads dates in words', () => {
    expect(fmt.money(-0.001)).toBe('$0.00');
    expect(fmt.money(-12)).toBe('−$12.00');
    expect(fmt.date('2026-10-09')).toBe('Oct 9, 2026');
  });
});

describe('the onboarding compliance packet', () => {
  const data: PacketData = {
    meta: { generatedAt: '2026-10-18T13:00:00Z', generatedBy: 'hr@example.com' },
    application: { id: '5b2c9e1a-7f0d-4c3e-8a21-9d6e0f4b7a11', status: 'APPROVED', track: 'STANDARD', position: 'Front desk agent', startDate: '2026-11-02', invitedAt: '2026-10-05T14:00:00Z', submittedAt: null },
    client: { name: 'Coastal' },
    associate: { firstName: 'Şükrü', lastName: 'Yıldız', email: 's@example.com', employmentType: 'CONTRACTOR_1099_INDIVIDUAL', phone: null, dob: null, addressLine1: null, addressLine2: null, city: null, state: null, zip: null },
    w4: null,
    payout: null,
    i9: null,
    tasks: [],
    policyAcks: [],
    esignAgreements: [],
    documents: [],
    audit: [],
  };
  it('lists only the sections it has, in order, and is fingerprinted', async () => {
    expect(packetSections(data)).toEqual(['Associate profile', 'Onboarding checklist', 'Policy acknowledgments', 'Electronic signatures', 'Document register', 'Audit trail']);
    expect(packetSections({ ...data, w4: {} as never, i9: {} as never })).toContain('Federal withholding (W-4)');
    expect(packetFingerprint(data)).toMatch(/^[0-9a-f]{64}$/);
    expect(packetFingerprint({ ...data, client: { name: 'Other' } })).not.toBe(packetFingerprint(data));
    expect((await renderCompliancePacket(data)).subarray(0, 5).toString()).toBe('%PDF-');
  });
});

describe('the e-sign certificate', () => {
  it('records signer, signature, time, IP, agent, agreement and hash', () => {
    const rows = certificateRows({ agreement: { id: 'a1', title: 'T', body: 'B' }, signer: { fullName: 'Nguyễn Thị Hằng', email: null }, signedAt: new Date('2026-10-16T14:32:05Z'), ipAddress: null, userAgent: null, typedName: 'Nguyễn Thị Hằng', hashOverride: 'abc' });
    expect(rows.map((r) => r.label)).toEqual(['Signer', 'Email', 'Typed signature', 'Signed at', 'IP address', 'User agent', 'Agreement ID', 'Document SHA-256']);
    expect(rows.find((r) => r.label === 'IP address')!.value).toBe('(not captured)');
    expect(rows.find((r) => r.label === 'Signed at')!.value).toContain('2026-10-16T14:32:05.000Z');
  });
  it('the letter and the agreement are deterministic for the same inputs', async () => {
    const at = new Date('2026-10-16T12:00:00Z');
    const letter = () => renderLetterPdf({ title: 'Offer', body: 'Dear Şükrü,\n\nWelcome.', issuedAt: at, issuedTo: 'Şükrü Yıldız', brand: { name: 'Alto HR' }, signer: { name: 'Dana' } });
    expect((await letter()).equals(await letter())).toBe(true);
    const agreement = { agreement: { id: 'a1', title: 'T', body: 'B' }, signer: { fullName: 'P', email: null }, signedAt: at, ipAddress: null, userAgent: null, typedName: 'P' };
    expect((await renderSignedAgreement(agreement)).equals(await renderSignedAgreement(agreement))).toBe(true);
  });
});
