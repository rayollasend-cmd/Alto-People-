import { describe, expect, it } from 'vitest';
import { findSensitiveNumbers, redactSensitiveNumbers } from '../sensitiveText.js';

describe('sensitive numbers in free text', () => {
  it('finds an SSN however it is written', () => {
    for (const t of ['my ssn is 123-45-6789', 'ssn 123 45 6789 thanks', '123456789', 'is it 078-05-1120?']) expect(findSensitiveNumbers(t), t).toContain('ssn');
  });
  it('finds an account or card number', () => {
    for (const t of ['acct 000123456789', 'card 4111 1111 1111 1111', 'IBAN-ish 1234-5678-9012-3456-789']) expect(findSensitiveNumbers(t), t).toContain('account');
  });
  it('leaves phone numbers, dates, times, amounts and short ids alone', () => {
    for (const t of ['call me at 850-555-0101', '+1 850 555 0101', 'shift on 2026-10-25 at 10:30', 'I worked 38.5 hours, $612.40', 'badge 4417', 'zip 32541', 'employee number 10023']) expect(findSensitiveNumbers(t), t).toEqual([]);
  });
  it('redacts every one, keeping the rest of the words', () => {
    expect(redactSensitiveNumbers('ssn 123-45-6789 and account 000123456789, call 850-555-0101')).toBe('ssn [number removed] and account [number removed], call 850-555-0101');
  });
});
