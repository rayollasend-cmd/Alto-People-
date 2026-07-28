import { describe, expect, it } from 'vitest';
import { encryptString } from '../../lib/crypto.js';
import { maskRoutingNumber, readRoutingNumber } from '../../lib/payoutMethod.js';

/**
 * PayoutMethod.routingNumberEnc is written in two formats by two routes:
 * plain UTF-8 (onboarding direct deposit) and AES-GCM ciphertext
 * (self-service). Readers that assumed one format silently produced garbage
 * or blanks for rows in the other.
 */
describe('readRoutingNumber', () => {
  it('reads the plaintext format the onboarding route writes', () => {
    expect(readRoutingNumber(Buffer.from('121000248', 'utf8'))).toBe('121000248');
  });

  it('reads the encrypted format the self-service route writes', () => {
    expect(readRoutingNumber(encryptString('121000248'))).toBe('121000248');
  });

  it('preserves a leading zero', () => {
    expect(readRoutingNumber(Buffer.from('021000021', 'utf8'))).toBe('021000021');
    expect(readRoutingNumber(encryptString('021000021'))).toBe('021000021');
  });

  it('returns empty rather than garbage for an unreadable blob', () => {
    // Not valid UTF-8 digits and not decryptable under the current key —
    // the shape a row left behind by a key rotation would have.
    expect(readRoutingNumber(Buffer.from([0x01, 0x02, 0x03, 0x04]))).toBe('');
  });

  it('returns empty for null', () => {
    expect(readRoutingNumber(null)).toBe('');
  });
});

describe('maskRoutingNumber', () => {
  it('masks all but the last four, in both formats', () => {
    expect(maskRoutingNumber(Buffer.from('121000248', 'utf8'))).toBe('•••••0248');
    expect(maskRoutingNumber(encryptString('121000248'))).toBe('•••••0248');
  });

  it('is null when nothing can be read, rather than masking garbage', () => {
    expect(maskRoutingNumber(Buffer.from([0xff, 0xfe]))).toBeNull();
    expect(maskRoutingNumber(null)).toBeNull();
  });
});
