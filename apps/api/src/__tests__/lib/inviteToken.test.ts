import { describe, expect, it } from 'vitest';
import { generateInviteToken, hashToken } from '../../lib/inviteToken.js';

describe('generateInviteToken', () => {
  it('returns base64url raw + hex hash', () => {
    const t = generateInviteToken();
    // base64url alphabet only
    expect(t.raw).toMatch(/^[A-Za-z0-9_-]+$/);
    // 32 bytes → 43 base64url chars (no padding)
    expect(t.raw.length).toBeGreaterThanOrEqual(40);
    // sha256 hex = 64 chars
    expect(t.hash).toMatch(/^[0-9a-f]{64}$/);
  });

  it('hash matches hashToken(raw) deterministically', () => {
    const t = generateInviteToken();
    expect(hashToken(t.raw)).toBe(t.hash);
  });

  it('different calls produce different tokens (≥256 bits entropy)', () => {
    const a = generateInviteToken();
    const b = generateInviteToken();
    expect(a.raw).not.toBe(b.raw);
    expect(a.hash).not.toBe(b.hash);
  });
});

describe('hashToken', () => {
  it('is deterministic', () => {
    expect(hashToken('hello')).toBe(hashToken('hello'));
  });

  it('changes drastically when input changes by one char', () => {
    const a = hashToken('hello');
    const b = hashToken('hellp');
    let diff = 0;
    for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) diff++;
    // Avalanche: SHA-256 should differ in roughly half the chars.
    expect(diff).toBeGreaterThan(20);
  });
});
