import { describe, expect, it } from 'vitest';
import { hashSignedPdf, renderSignedAgreement } from '../../lib/esign.js';

const fixedSignedAt = new Date('2026-04-01T12:00:00.000Z');

const baseInput = {
  agreement: {
    id: '00000000-0000-0000-0000-000000000001',
    title: 'Confidentiality agreement',
    body: 'I agree to keep all proprietary information confidential.\n\nThis agreement is binding upon my electronic signature.',
  },
  signer: { fullName: 'Pat Hopeful', email: 'pat@example.com' },
  signedAt: fixedSignedAt,
  ipAddress: '203.0.113.10',
  userAgent: 'Mozilla/5.0 (Windows NT 10.0)',
  typedName: 'Pat Hopeful',
};

describe('renderSignedAgreement', () => {
  it('produces a valid PDF (magic bytes %PDF-)', async () => {
    const pdf = await renderSignedAgreement(baseInput);
    expect(pdf.length).toBeGreaterThan(1000);
    expect(pdf.slice(0, 5).toString()).toBe('%PDF-');
  });

  it('different typed names produce different bytes (proves the name is in the stream)', async () => {
    // pdfkit compresses content streams so we can't grep the raw bytes.
    // Compare the hashes instead — same inputs except typedName must
    // diverge bytes, which proves the name made it into the document.
    const a = await renderSignedAgreement(baseInput);
    const b = await renderSignedAgreement({ ...baseInput, typedName: 'Different Person' });
    expect(a.equals(b)).toBe(false);
  });

  it('is deterministic — same inputs produce identical bytes (and hash)', async () => {
    const a = await renderSignedAgreement(baseInput);
    const b = await renderSignedAgreement(baseInput);
    expect(hashSignedPdf(a)).toBe(hashSignedPdf(b));
    expect(a.equals(b)).toBe(true);
  });

  it('changes the hash when the typed name changes', async () => {
    const a = await renderSignedAgreement(baseInput);
    const b = await renderSignedAgreement({ ...baseInput, typedName: 'Pat H. Hopeful' });
    expect(hashSignedPdf(a)).not.toBe(hashSignedPdf(b));
  });

  it('changes the hash when IP address changes', async () => {
    const a = await renderSignedAgreement(baseInput);
    const b = await renderSignedAgreement({ ...baseInput, ipAddress: '198.51.100.7' });
    expect(hashSignedPdf(a)).not.toBe(hashSignedPdf(b));
  });

  it('handles missing IP / user agent without crashing', async () => {
    const pdf = await renderSignedAgreement({
      ...baseInput,
      ipAddress: null,
      userAgent: null,
    });
    expect(pdf.slice(0, 5).toString()).toBe('%PDF-');
  });
});
