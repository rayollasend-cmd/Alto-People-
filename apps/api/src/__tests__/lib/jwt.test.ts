import { describe, expect, it } from 'vitest';
import jwt from 'jsonwebtoken';
import { signSession, verifySession } from '../../lib/jwt.js';

describe('signSession / verifySession round-trip', () => {
  it('preserves sub, role, ver', () => {
    const token = signSession({ sub: 'user-123', role: 'HR_ADMINISTRATOR', ver: 7 });
    const payload = verifySession(token);
    expect(payload).not.toBeNull();
    expect(payload!.sub).toBe('user-123');
    expect(payload!.role).toBe('HR_ADMINISTRATOR');
    expect(payload!.ver).toBe(7);
    expect(typeof payload!.iat).toBe('number');
    expect(typeof payload!.exp).toBe('number');
    expect(payload!.exp).toBeGreaterThan(payload!.iat);
  });
});

describe('verifySession failure modes', () => {
  it('returns null for a tampered token', () => {
    const token = signSession({ sub: 'user-123', role: 'ASSOCIATE', ver: 0 });
    const tampered = token.slice(0, -4) + 'AAAA';
    expect(verifySession(tampered)).toBeNull();
  });

  it('returns null for a token signed with a different secret', () => {
    const wrong = jwt.sign(
      { sub: 'u', role: 'ASSOCIATE', ver: 0 },
      'some-other-secret-that-is-also-32-chars-long',
      { algorithm: 'HS256', expiresIn: 60 }
    );
    expect(verifySession(wrong)).toBeNull();
  });

  it('returns null for an expired token', () => {
    const expired = jwt.sign(
      { sub: 'u', role: 'ASSOCIATE', ver: 0 },
      process.env.JWT_SECRET!,
      { algorithm: 'HS256', expiresIn: -10 }
    );
    expect(verifySession(expired)).toBeNull();
  });

  it('returns null for tokens missing required fields', () => {
    const noRole = jwt.sign(
      { sub: 'u', ver: 0 } as object,
      process.env.JWT_SECRET!,
      { algorithm: 'HS256', expiresIn: 60 }
    );
    expect(verifySession(noRole)).toBeNull();
  });

  it('returns null for tokens with wrong-type fields', () => {
    const badVer = jwt.sign(
      { sub: 'u', role: 'ASSOCIATE', ver: 'zero' } as object,
      process.env.JWT_SECRET!,
      { algorithm: 'HS256', expiresIn: 60 }
    );
    expect(verifySession(badVer)).toBeNull();
  });

  it('returns null for garbage input', () => {
    expect(verifySession('not.a.token')).toBeNull();
    expect(verifySession('')).toBeNull();
  });
});
