import { describe, expect, it } from 'vitest';
import {
  decryptBytes,
  decryptString,
  encryptBytes,
  encryptString,
} from '../../lib/crypto.js';

describe('crypto round-trip', () => {
  it('encryptString / decryptString preserves ASCII', () => {
    const plain = 'hello world';
    const blob = encryptString(plain);
    expect(decryptString(blob)).toBe(plain);
  });

  it('round-trips multi-byte UTF-8', () => {
    const plain = '🦀 Ærø — café';
    expect(decryptString(encryptString(plain))).toBe(plain);
  });

  it('round-trips an empty string', () => {
    expect(decryptString(encryptString(''))).toBe('');
  });

  it('round-trips a 9-digit SSN-like payload', () => {
    const plain = '123456789';
    expect(decryptString(encryptString(plain))).toBe(plain);
  });
});

describe('crypto envelope format', () => {
  it('first byte is the version (1)', () => {
    const blob = encryptString('x');
    expect(blob[0]).toBe(1);
  });

  it('total length is 1 (version) + 12 (iv) + plaintext + 16 (tag)', () => {
    const plain = '123456789';
    const blob = encryptString(plain);
    expect(blob.length).toBe(1 + 12 + plain.length + 16);
  });

  it('two encryptions of the same plaintext produce different ciphertexts (random IV)', () => {
    const a = encryptString('same');
    const b = encryptString('same');
    expect(a.equals(b)).toBe(false);
    // But both decrypt to the same plaintext
    expect(decryptString(a)).toBe('same');
    expect(decryptString(b)).toBe('same');
  });
});

describe('crypto failure modes', () => {
  it('tampered ciphertext fails (auth tag mismatch)', () => {
    const blob = encryptString('secret');
    const tampered = Buffer.from(blob);
    // Flip a bit in the middle of the ciphertext (between IV and tag).
    tampered[1 + 12 + 1] ^= 0x01;
    expect(() => decryptBytes(tampered)).toThrow('decryption failed');
  });

  it('tampered auth tag fails', () => {
    const blob = encryptString('secret');
    const tampered = Buffer.from(blob);
    tampered[tampered.length - 1] ^= 0xff;
    expect(() => decryptBytes(tampered)).toThrow('decryption failed');
  });

  it('blob shorter than min envelope size fails cleanly (no buffer overflow crash)', () => {
    expect(() => decryptBytes(Buffer.alloc(5))).toThrow('decryption failed');
    expect(() => decryptBytes(Buffer.alloc(0))).toThrow('decryption failed');
  });

  it('unknown version byte fails', () => {
    const blob = encryptString('secret');
    blob[0] = 99;
    expect(() => decryptBytes(blob)).toThrow('decryption failed');
  });

  it('errors do not include plaintext', () => {
    const blob = encryptString('TOP-SECRET-PAYLOAD-7K3X');
    blob[blob.length - 1] ^= 0xff;
    try {
      decryptBytes(blob);
      throw new Error('should have thrown');
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      expect(msg).not.toContain('TOP-SECRET-PAYLOAD-7K3X');
    }
  });
});

describe('crypto Buffer round-trip', () => {
  it('encryptBytes / decryptBytes round-trip arbitrary bytes', () => {
    const plain = Buffer.from([0x00, 0xff, 0x7f, 0x80, 0x01, 0xfe]);
    expect(decryptBytes(encryptBytes(plain)).equals(plain)).toBe(true);
  });
});
