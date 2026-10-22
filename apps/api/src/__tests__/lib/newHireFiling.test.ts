import { describe, expect, it } from 'vitest';
import {
  CSV_MANUAL_UPLOAD_PROVIDER,
  filingStatus,
  providerForState,
  registerNewHireProvider,
  unregisterNewHireProvider,
} from '../../lib/newHireReporting.js';

/**
 * The new-hire filing provider that ships is the CSV for the state portal,
 * registered formally so the product says "manual upload" instead of
 * implying an electronic filing. An electronic service, once connected
 * for a state, takes over for that state only.
 */
describe('new-hire filing providers', () => {
  it('the CSV provider is registered, reports manual upload, and never files for a state', async () => {
    expect(providerForState('FL')).toBeNull();
    expect(filingStatus('FL')).toMatchObject({ kind: 'MANUAL_UPLOAD', configured: true, provider: { key: 'csv-manual-upload', label: 'CSV for the state portal' } });
    expect(filingStatus().note).toMatch(/upload it at the state new-hire portal/);
    await expect(CSV_MANUAL_UPLOAD_PROVIDER.submit('FL', [])).rejects.toThrow(/does not file/);
  });

  it('an electronic service connected for one state files there; every other state stays manual', () => {
    registerNewHireProvider({ key: 'mock', label: 'Mock filer', states: ['ME'], submit: async () => ({ confirmation: 'ME-1' }) });
    try {
      expect(providerForState('ME')?.key).toBe('mock');
      expect(filingStatus('ME')).toMatchObject({ kind: 'ELECTRONIC', provider: { key: 'mock' } });
      expect(filingStatus('FL').kind).toBe('MANUAL_UPLOAD');
    } finally {
      unregisterNewHireProvider('mock');
    }
    expect(providerForState('ME')).toBeNull();
  });
});
