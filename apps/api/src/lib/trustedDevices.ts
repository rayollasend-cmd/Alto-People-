import { createHash, randomBytes } from 'node:crypto';
import type { Request, Response } from 'express';
import type { PrismaClient } from '@prisma/client';
import { env } from '../config/env.js';
import { prisma } from '../db.js';

/**
 * Access pack — "remember this device".
 *
 *   After a two-step sign-in, with device trust on for the tenant, the
 *   browser gets a long-lived cookie holding a random token; its hash is
 *   the TrustedDevice row. The next password sign-in from that browser
 *   skips the code for as long as the row lives (policy days), is not
 *   revoked, and belongs to the same account. A device is revoked from
 *   Settings; disabling device trust for the tenant makes every row inert
 *   at once because the check reads the policy first.
 *
 *   Same cookie posture as the session cookie (__Host- in production).
 */

export const DEVICE_COOKIE = env.NODE_ENV === 'production' ? '__Host-alto.device' : 'alto.device';

const hash = (t: string) => createHash('sha256').update(t, 'utf8').digest('hex');

export function deviceLabelFor(req: Request): string {
  const ua = String(req.headers['user-agent'] ?? '');
  const browser = /Edg\//.test(ua) ? 'Edge' : /OPR\//.test(ua) ? 'Opera' : /Chrome\//.test(ua) ? 'Chrome' : /Safari\//.test(ua) ? 'Safari' : /Firefox\//.test(ua) ? 'Firefox' : 'Browser';
  const os = /iPhone|iPad/.test(ua) ? 'iOS' : /Android/.test(ua) ? 'Android' : /Mac OS X/.test(ua) ? 'macOS' : /Windows/.test(ua) ? 'Windows' : /Linux/.test(ua) ? 'Linux' : 'device';
  return `${browser} on ${os}`.slice(0, 200);
}

/** The device the request presents, when it is a live trusted device of `userId`. */
export async function trustedDeviceFor(req: Request, userId: string, db: PrismaClient = prisma): Promise<{ id: string } | null> {
  const raw = req.cookies?.[DEVICE_COOKIE] as string | undefined;
  if (!raw || typeof raw !== 'string' || raw.length > 200) return null;
  const row = await db.trustedDevice.findFirst({
    where: { tokenHash: hash(raw), userId, revokedAt: null, expiresAt: { gt: new Date() } },
    select: { id: true },
  });
  if (row) void db.trustedDevice.update({ where: { id: row.id }, data: { lastSeenAt: new Date() } }).catch(() => undefined);
  return row;
}

/** Remember this device for `days`: a new row and the cookie that names it. */
export async function rememberDevice(req: Request, res: Response, userId: string, days: number, db: PrismaClient = prisma): Promise<string> {
  const token = randomBytes(32).toString('base64url');
  const expiresAt = new Date(Date.now() + days * 86_400_000);
  const row = await db.trustedDevice.create({
    data: { userId, tokenHash: hash(token), label: deviceLabelFor(req), ip: req.ip ?? null, expiresAt },
    select: { id: true },
  });
  res.cookie(DEVICE_COOKIE, token, {
    httpOnly: true,
    sameSite: 'lax',
    secure: env.NODE_ENV === 'production',
    path: '/',
    maxAge: days * 86_400_000,
  });
  return row.id;
}

export async function revokeDevice(userId: string, id: string, db: PrismaClient = prisma): Promise<boolean> {
  const r = await db.trustedDevice.updateMany({ where: { id, userId, revokedAt: null }, data: { revokedAt: new Date() } });
  return r.count > 0;
}

export async function listDevices(userId: string, db: PrismaClient = prisma) {
  const rows = await db.trustedDevice.findMany({
    where: { userId, revokedAt: null, expiresAt: { gt: new Date() } },
    orderBy: { lastSeenAt: 'desc' },
    select: { id: true, label: true, ip: true, createdAt: true, lastSeenAt: true, expiresAt: true },
    take: 50,
  });
  return rows.map((r) => ({ ...r, createdAt: r.createdAt.toISOString(), lastSeenAt: r.lastSeenAt.toISOString(), expiresAt: r.expiresAt.toISOString() }));
}
