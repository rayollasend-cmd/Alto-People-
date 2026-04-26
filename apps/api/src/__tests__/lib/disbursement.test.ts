import { afterEach, describe, expect, it } from 'vitest';
import { _setAdapterForTesting, pickAdapter, type DisbursementAdapter } from '../../lib/disbursement.js';

afterEach(() => _setAdapterForTesting(null));

describe('disbursement adapter', () => {
  it('default (no env) is the StubAdapter', async () => {
    _setAdapterForTesting(null);
    const adapter = pickAdapter();
    expect(adapter.provider).toBe('STUB');
    const r = await adapter.disburse({
      amount: 123.45,
      currency: 'USD',
      recipient: { associateId: 'a-1', fullName: 'Pat Hopeful' },
      idempotencyKey: 'item-abcdef1234',
    });
    expect(r.provider).toBe('STUB');
    expect(r.status).toBe('SUCCESS');
    expect(r.externalRef).toMatch(/^STUB-item-abc/);
    expect(r.failureReason).toBeNull();
  });

  it('idempotency key drives a deterministic external ref', async () => {
    _setAdapterForTesting(null);
    const a1 = await pickAdapter().disburse({
      amount: 1,
      currency: 'USD',
      recipient: { associateId: 'a', fullName: 'X' },
      idempotencyKey: 'same-key',
    });
    const a2 = await pickAdapter().disburse({
      amount: 999,
      currency: 'USD',
      recipient: { associateId: 'b', fullName: 'Y' },
      idempotencyKey: 'same-key',
    });
    expect(a1.externalRef).toBe(a2.externalRef);
  });

  it('a forced adapter via _setAdapterForTesting is used by the route layer', async () => {
    const fake: DisbursementAdapter = {
      provider: 'WISE',
      async disburse() {
        return { provider: 'WISE', externalRef: 'wise-123', status: 'SUCCESS', failureReason: null };
      },
    };
    _setAdapterForTesting(fake);
    const r = await pickAdapter().disburse({
      amount: 1,
      currency: 'USD',
      recipient: { associateId: 'a', fullName: 'X' },
      idempotencyKey: 'k',
    });
    expect(r.externalRef).toBe('wise-123');
    expect(r.provider).toBe('WISE');
  });
});
