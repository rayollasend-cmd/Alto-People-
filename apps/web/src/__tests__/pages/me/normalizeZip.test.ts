import { describe, expect, it } from 'vitest';
import { normalizeZip } from '@/pages/me/MeHome';

/** The profile form fixes a ZIP the API would refuse, or says what it needs (Sentry ALTO-PEOPLE-API-14). */
describe('normalizeZip', () => {
  it('keeps a 5-digit ZIP and a ZIP+4', () => {
    expect(normalizeZip('32541')).toBe('32541');
    expect(normalizeZip(' 32541-1234 ')).toBe('32541-1234');
  });

  it('puts the dash back in nine digits in a row', () => {
    expect(normalizeZip('325411234')).toBe('32541-1234');
    expect(normalizeZip('32541 1234')).toBe('32541-1234');
  });

  it("refuses what can't be a US ZIP", () => {
    expect(normalizeZip('3254')).toBeNull();
    expect(normalizeZip('K1A 0B1')).toBeNull();
    expect(normalizeZip('32541-12')).toBeNull();
  });
});
