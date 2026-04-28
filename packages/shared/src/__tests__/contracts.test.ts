import { describe, expect, it } from 'vitest';
import {
  ApplicationCreateInputSchema,
  DirectDepositInputSchema,
  LoginRequestSchema,
  PolicyAckInputSchema,
  ProfileSubmissionSchema,
  W4SubmissionInputSchema,
} from '../contracts.js';

describe('LoginRequestSchema', () => {
  it('accepts a 12-character password', () => {
    const r = LoginRequestSchema.safeParse({
      email: 'admin@altohr.com',
      password: 'a'.repeat(12),
    });
    expect(r.success).toBe(true);
  });

  it('rejects passwords shorter than 12 chars', () => {
    const r = LoginRequestSchema.safeParse({
      email: 'admin@altohr.com',
      password: 'a'.repeat(11),
    });
    expect(r.success).toBe(false);
  });

  it('rejects malformed emails', () => {
    const r = LoginRequestSchema.safeParse({
      email: 'not-an-email',
      password: 'a'.repeat(12),
    });
    expect(r.success).toBe(false);
  });

  it('does not trim email — that is the route handler\'s job', () => {
    const padded = '  admin@altohr.com  ';
    const r = LoginRequestSchema.safeParse({ email: padded, password: 'a'.repeat(12) });
    // " admin@altohr.com " is not a valid email per zod's strict regex.
    // We just want to assert the schema doesn't silently mutate input.
    expect(r.success).toBe(false);
  });
});

describe('ApplicationCreateInputSchema', () => {
  const validBase = {
    associateEmail: 'new.hire@example.com',
    associateFirstName: 'Demo',
    associateLastName: 'Hire',
    clientId: '00000000-0000-4000-8000-000000000000',
    templateId: '00000000-0000-4000-8000-000000000001',
  };

  it('accepts a minimal valid input', () => {
    expect(ApplicationCreateInputSchema.safeParse(validBase).success).toBe(true);
  });

  it('accepts position + ISO startDate', () => {
    const r = ApplicationCreateInputSchema.safeParse({
      ...validBase,
      position: 'Server',
      startDate: '2026-05-01T00:00:00.000Z',
    });
    expect(r.success).toBe(true);
  });

  it('rejects empty firstName', () => {
    const r = ApplicationCreateInputSchema.safeParse({ ...validBase, associateFirstName: '' });
    expect(r.success).toBe(false);
  });

  it('rejects non-uuid clientId', () => {
    const r = ApplicationCreateInputSchema.safeParse({ ...validBase, clientId: 'not-a-uuid' });
    expect(r.success).toBe(false);
  });
});

describe('ProfileSubmissionSchema', () => {
  it('accepts state two-letter code', () => {
    const r = ProfileSubmissionSchema.safeParse({
      firstName: 'A',
      lastName: 'B',
      state: 'FL',
    });
    expect(r.success).toBe(true);
  });

  it('rejects state code longer than 2 chars', () => {
    const r = ProfileSubmissionSchema.safeParse({
      firstName: 'A',
      lastName: 'B',
      state: 'FLA',
    });
    expect(r.success).toBe(false);
  });
});

describe('W4SubmissionInputSchema', () => {
  it('applies numeric defaults', () => {
    const r = W4SubmissionInputSchema.safeParse({ filingStatus: 'SINGLE' });
    expect(r.success).toBe(true);
    if (r.success) {
      expect(r.data.dependentsAmount).toBe(0);
      expect(r.data.otherIncome).toBe(0);
      expect(r.data.deductions).toBe(0);
      expect(r.data.extraWithholding).toBe(0);
      expect(r.data.multipleJobs).toBe(false);
    }
  });

  it('rejects negative amounts', () => {
    const r = W4SubmissionInputSchema.safeParse({
      filingStatus: 'SINGLE',
      dependentsAmount: -1,
    });
    expect(r.success).toBe(false);
  });

  it('accepts SSN with or without dashes', () => {
    expect(
      W4SubmissionInputSchema.safeParse({ filingStatus: 'SINGLE', ssn: '123-45-6789' }).success
    ).toBe(true);
    expect(
      W4SubmissionInputSchema.safeParse({ filingStatus: 'SINGLE', ssn: '123456789' }).success
    ).toBe(true);
  });

  it('rejects SSN with non-digits', () => {
    expect(
      W4SubmissionInputSchema.safeParse({ filingStatus: 'SINGLE', ssn: '12X-45-6789' }).success
    ).toBe(false);
  });

  it('rejects unknown filing status', () => {
    expect(
      W4SubmissionInputSchema.safeParse({ filingStatus: 'WIDOW' as never }).success
    ).toBe(false);
  });
});

describe('DirectDepositInputSchema', () => {
  it('BANK_ACCOUNT requires routing + account + account type', () => {
    expect(
      DirectDepositInputSchema.safeParse({
        type: 'BANK_ACCOUNT',
        routingNumber: '123456789',
        accountNumber: '12345678',
        accountType: 'CHECKING',
      }).success
    ).toBe(true);
  });

  it('BANK_ACCOUNT rejects 8-digit routing number', () => {
    expect(
      DirectDepositInputSchema.safeParse({
        type: 'BANK_ACCOUNT',
        routingNumber: '12345678',
        accountNumber: '12345678',
        accountType: 'CHECKING',
      }).success
    ).toBe(false);
  });

  it('BANK_ACCOUNT rejects 3-digit account number', () => {
    expect(
      DirectDepositInputSchema.safeParse({
        type: 'BANK_ACCOUNT',
        routingNumber: '123456789',
        accountNumber: '123',
        accountType: 'CHECKING',
      }).success
    ).toBe(false);
  });

  it('BRANCH_CARD requires branchCardId', () => {
    expect(
      DirectDepositInputSchema.safeParse({
        type: 'BRANCH_CARD',
        branchCardId: 'BC-12345',
      }).success
    ).toBe(true);
    expect(
      DirectDepositInputSchema.safeParse({
        type: 'BRANCH_CARD',
        branchCardId: '',
      }).success
    ).toBe(false);
  });

  it('rejects mixing the two variants (discriminated union)', () => {
    expect(
      DirectDepositInputSchema.safeParse({
        type: 'BANK_ACCOUNT',
        branchCardId: 'BC-12345',
      }).success
    ).toBe(false);
  });
});

describe('PolicyAckInputSchema', () => {
  it('accepts a uuid policyId', () => {
    expect(
      PolicyAckInputSchema.safeParse({
        policyId: '00000000-0000-4000-8000-000000000000',
      }).success
    ).toBe(true);
  });

  it('rejects missing policyId', () => {
    expect(PolicyAckInputSchema.safeParse({}).success).toBe(false);
  });

  it('rejects non-uuid policyId', () => {
    expect(PolicyAckInputSchema.safeParse({ policyId: 'foo' }).success).toBe(false);
  });
});
