import { describe, expect, it } from 'vitest';
import { auditDiff, maskValue } from '../../lib/auditDiff.js';

/** Brief 2-3 step 4 — what a before/after audit row may hold. */
describe('auditDiff', () => {
  it('records only the watched fields that changed', () => {
    const d = auditDiff('User', ['role', 'lastLoginAt', 'status'], { role: 'ASSOCIATE', status: 'ACTIVE', lastLoginAt: null }, { role: 'MANAGER', status: 'ACTIVE', lastLoginAt: new Date() });
    expect(d).toEqual({ changed: ['role'], before: { role: 'ASSOCIATE' }, after: { role: 'MANAGER' } });
  });

  it('is null when nothing watched changed, and for a model it does not audit', () => {
    expect(auditDiff('User', ['lastLoginAt'], { lastLoginAt: null }, { lastLoginAt: new Date() })).toBeNull();
    expect(auditDiff('User', ['role'], { role: 'MANAGER' }, { role: 'MANAGER' })).toBeNull();
    expect(auditDiff('Shift', ['status'], { status: 'DRAFT' }, { status: 'OPEN' })).toBeNull();
  });

  it('never writes a secret in clear', () => {
    const d = auditDiff(
      'PayoutMethod',
      ['accountNumberEnc', 'routingNumberEnc', 'accountLast4', 'bankName'],
      { accountNumberEnc: Buffer.from('old'), routingNumberEnc: Buffer.from('a'), accountLast4: '1111', bankName: 'First' },
      { accountNumberEnc: Buffer.from('new'), routingNumberEnc: Buffer.from('b'), accountLast4: '2222', bankName: 'Second' },
    )!;
    expect(d.before).toEqual({ accountNumberEnc: '[set]', routingNumberEnc: '[set]', accountLast4: '1111', bankName: 'First' });
    expect(d.after).toEqual({ accountNumberEnc: '[changed]', routingNumberEnc: '[changed]', accountLast4: '2222', bankName: 'Second' });
    const w4 = auditDiff('W4Submission', ['ssnEncrypted', 'filingStatus'], { ssnEncrypted: Buffer.from('x'), filingStatus: 'SINGLE' }, { ssnEncrypted: Buffer.from('y'), filingStatus: 'MARRIED' })!;
    expect(JSON.stringify(w4)).not.toMatch(/\d{3}-?\d{2}-?\d{4}/);
    expect(w4.after).toEqual({ ssnEncrypted: '[changed]', filingStatus: 'MARRIED' });
    expect(auditDiff('User', ['passwordHash'], { passwordHash: '$argon2id$a' }, { passwordHash: '$argon2id$b' })!.after).toEqual({ passwordHash: '[changed]' });
  });

  it('shows a tax id or account number by its last four only', () => {
    expect(maskValue('ein', '12-3456789')).toBe('••••6789');
    expect(maskValue('ssn', '123-45-6789')).toBe('••••6789');
    expect(maskValue('accountNumber', '12')).toBe('[changed]');
    const d = auditDiff('TaxForm', ['ein', 'status'], { ein: '12-3456789', status: 'DRAFT' }, { ein: '98-7654321', status: 'FILED' })!;
    expect(d.before).toEqual({ ein: '••••6789', status: 'DRAFT' });
    expect(d.after).toEqual({ ein: '••••4321', status: 'FILED' });
  });

  it('compares dates and decimals by value', () => {
    const t = new Date('2026-10-01T00:00:00Z');
    expect(auditDiff('Employment', ['hireDate'], { hireDate: t }, { hireDate: new Date(t) })).toBeNull();
    const d = auditDiff('CompensationRecord', ['amount'], { amount: { toFixed: () => '15', toString: () => '15' } }, { amount: { toFixed: () => '18', toString: () => '18' } })!;
    expect(d.after).toEqual({ amount: '18' });
  });
});
