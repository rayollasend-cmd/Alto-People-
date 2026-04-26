import jwt from 'jsonwebtoken';
import type { Role } from '@alto-people/shared';
import { env } from '../config/env.js';

export interface SessionPayload {
  sub: string; // user id
  role: Role;
  ver: number; // tokenVersion
  iat: number;
  exp: number;
}

export function signSession(input: {
  sub: string;
  role: Role;
  ver: number;
}): string {
  return jwt.sign(
    { sub: input.sub, role: input.role, ver: input.ver },
    env.JWT_SECRET,
    { algorithm: 'HS256', expiresIn: env.JWT_TTL_SECONDS }
  );
}

export function verifySession(raw: string): SessionPayload | null {
  try {
    const decoded = jwt.verify(raw, env.JWT_SECRET, {
      algorithms: ['HS256'],
    });
    if (typeof decoded === 'string') return null;

    const { sub, role, ver, iat, exp } = decoded as Record<string, unknown>;
    if (
      typeof sub !== 'string' ||
      typeof role !== 'string' ||
      typeof ver !== 'number' ||
      typeof iat !== 'number' ||
      typeof exp !== 'number'
    ) {
      return null;
    }
    return { sub, role: role as Role, ver, iat, exp };
  } catch {
    return null;
  }
}
