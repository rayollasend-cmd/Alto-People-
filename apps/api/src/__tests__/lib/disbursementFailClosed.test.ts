import { afterEach, describe, expect, it, vi } from 'vitest';

/**
 * Deep audit CODE-25: a failed read of the tenant's payroll banking profile
 * used to be swallowed (`.catch(() => null)`), and pay went out on the
 * platform's rail instead of the one the tenant chose — its own ACH, behind
 * its funding gate. Money fails closed: the error reaches the caller and no
 * adapter is handed back.
 */

const readProfile = vi.fn();
vi.mock('../../lib/banking/ach.js', () => ({ bankingProfile: (...args: unknown[]) => readProfile(...args) }));
vi.mock('../../lib/providers/connections.js', () => ({ activeConnection: async () => null, contextFor: () => ({ credentials: {} }) }));

const { _setAdapterForTesting, resolveAdapter } = await import('../../lib/disbursement.js');

afterEach(() => {
  readProfile.mockReset();
  _setAdapterForTesting(null);
});

describe('resolveAdapter fails closed', () => {
  it('a banking-profile read error stops the payout instead of picking the platform rail', async () => {
    readProfile.mockRejectedValue(new Error('connection terminated unexpectedly'));
    await expect(resolveAdapter({ batch: true })).rejects.toThrow(/connection terminated/);
  });

  it('a profile on the platform rail still gets the platform adapter', async () => {
    readProfile.mockResolvedValue({ bankRail: 'PLATFORM' });
    const adapter = await resolveAdapter();
    expect(adapter.provider).toBeTruthy();
  });
});
