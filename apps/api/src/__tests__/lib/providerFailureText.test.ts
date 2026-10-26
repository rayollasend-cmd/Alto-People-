import { describe, expect, it } from 'vitest';
import { providerFailureText } from '../../lib/providers/failureText.js';

/**
 * F500 audit 2026-10-26: the Payouts card read "Wise refused the token
 * (HTTP 401): Invalid token". The card says what stopped and what to do;
 * the vendor's words ride along as the detail.
 */
describe('providerFailureText', () => {
  const wise = { label: 'Wise', kind: 'PAYOUT' as const };

  it('turns a refused token into "reconnect to resume", keeping the record as detail', () => {
    for (const raw of ['Wise refused the token (HTTP 401): Invalid token', 'wise_profiles_failed (HTTP 401): Invalid token', '401 Unauthorized', 'Wise refused the token.']) {
      expect(providerFailureText(raw, wise)).toEqual({ message: 'Wise rejected the saved credentials — reconnect to resume payouts.', detail: raw });
    }
    expect(providerFailureText('Bad authentication (HTTP 401)', { label: 'Checkr', kind: 'BACKGROUND_CHECK' })?.message).toBe(
      'Checkr rejected the saved credentials — reconnect to resume background checks.',
    );
  });

  it('names timeouts, unreachable hosts, their outages and signature failures in words', () => {
    expect(providerFailureText('The provider did not answer in time.', wise)?.message).toBe("Wise didn't answer in time. Test the connection again in a few minutes.");
    expect(providerFailureText('Could not reach the provider.', wise)?.message).toBe("We couldn't reach Wise. Check the connection's address, then test it again.");
    expect(providerFailureText('Checkr answered 503.', { label: 'Checkr', kind: 'BACKGROUND_CHECK' })?.message).toBe('Checkr had a problem on their side. Test the connection again in a few minutes.');
    expect(providerFailureText('Signature does not match.', wise)?.message).toMatch(/failed its signature check/);
    expect(providerFailureText('TaxBandits answered 422.', { label: 'TaxBandits', kind: 'TAX_FILING' })).toEqual({
      message: "TaxBandits turned the request down. Check the connection's settings, then test it again.",
      detail: 'TaxBandits answered 422.',
    });
  });

  it('leaves a sentence that is already plain alone, and nothing as nothing', () => {
    expect(providerFailureText('Enter the client ID and secret.', { label: 'Plaid', kind: 'BANK_FEED' })).toEqual({ message: 'Enter the client ID and secret.', detail: null });
    expect(providerFailureText('background check not run: provider not configured', { label: 'Checkr' })?.message).toBe('Background check not run: provider not configured');
    expect(providerFailureText(null, wise)).toBeNull();
    expect(providerFailureText('   ', wise)).toBeNull();
  });

  it('never leaks a status code or a snake_case code into the message', () => {
    for (const raw of ['wise_quote_failed (HTTP 400): bad currency', 'Vertex answered 418.', 'ECONNREFUSED 10.0.0.1:443']) {
      const out = providerFailureText(raw, wise)!;
      expect(out.message).not.toMatch(/\d{3}|_/);
      expect(out.detail).toBe(raw);
    }
  });
});
