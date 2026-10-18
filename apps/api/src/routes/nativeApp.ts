import { Router, type Request, type Response } from 'express';
import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import sharp from 'sharp';
import { z } from 'zod';
import { prisma } from '../db.js';
import { env } from '../config/env.js';
import { HttpError } from '../middleware/error.js';
import { invalidateUserCache, requireAuth, SESSION_COOKIE } from '../middleware/auth.js';
import { signSession, type AuthMethod } from '../lib/jwt.js';
import { enqueueAudit } from '../lib/audit.js';
import { tenantIdForWrite } from '../lib/tenant.js';
import { getBrandingSync } from '../lib/branding.js';
import { decryptString } from '../lib/crypto.js';
import { getBlobStore } from '../lib/blobStore.js';
import { signBadgeToken } from '../lib/badgeToken.js';
import { appleWalletConfigured, appleWalletMissing, buildBadgePass } from '../lib/appleWallet.js';
import { googleSaveUrl, googleWalletConfigured, googleWalletMissing } from '../lib/googleWallet.js';
import { loadSecurityPolicy } from '../lib/securityPolicy.js';

/**
 * The native apps (apps/mobile, iOS + Android).
 *
 *   /devices                  the phones a person has the app on: register
 *                             (push token + a refresh credential for the
 *                             Keychain/Keystore), update, list, revoke.
 *   /auth/device-session      re-open a session the web view lost, from
 *                             the Keychain credential (rotated each use).
 *   /auth/native-handoff      carry a sign-in finished in the system
 *   /auth/native-exchange     browser (SSO, passkeys) into the app: a
 *                             two-minute, single-use code.
 *   /me/wallet/badge…         the worker's badge — QR / NFC credential,
 *                             Apple Wallet pass, Google Wallet link.
 */

export const nativeAppRouter = Router();

const sha256 = (s: string): Uint8Array<ArrayBuffer> => new Uint8Array(createHash('sha256').update(s).digest());

function cookieOptions() {
  return {
    httpOnly: true,
    sameSite: 'lax' as const,
    secure: env.NODE_ENV === 'production',
    path: '/',
    maxAge: env.JWT_TTL_SECONDS * 1000,
  };
}

/** A device credential lives at most this long — or the tenant's absolute session life, if shorter. */
const CREDENTIAL_DAYS = 30;

async function credentialExpiry(tenantId: string | null): Promise<Date> {
  const policy = await loadSecurityPolicy(tenantId ?? tenantIdForWrite());
  const days = CREDENTIAL_DAYS * 24;
  const hours = policy.sessionAbsoluteHours ? Math.min(policy.sessionAbsoluteHours, days) : days;
  return new Date(Date.now() + hours * 3_600_000);
}

function mintCredential(deviceId: string): { plaintext: string; hash: Uint8Array<ArrayBuffer> } {
  const plaintext = `altodev1.${deviceId}.${randomBytes(32).toString('base64url')}`;
  return { plaintext, hash: sha256(plaintext) };
}

const deviceView = (d: {
  id: string;
  platform: 'IOS' | 'ANDROID';
  deviceName: string | null;
  deviceModel: string | null;
  osVersion: string | null;
  appVersion: string | null;
  pushToken: string | null;
  biometricLock: boolean;
  lastSeenAt: Date;
  createdAt: Date;
}, currentId?: string | null) => ({
  id: d.id,
  platform: d.platform,
  deviceName: d.deviceName,
  deviceModel: d.deviceModel,
  osVersion: d.osVersion,
  appVersion: d.appVersion,
  notifications: !!d.pushToken,
  biometricLock: d.biometricLock,
  lastSeenAt: d.lastSeenAt.toISOString(),
  createdAt: d.createdAt.toISOString(),
  current: currentId ? d.id === currentId : false,
});

const DEVICE_SELECT = {
  id: true,
  platform: true,
  deviceName: true,
  deviceModel: true,
  osVersion: true,
  appVersion: true,
  pushToken: true,
  biometricLock: true,
  lastSeenAt: true,
  createdAt: true,
} as const;

/* ----- Devices ------------------------------------------------------------ */

const RegisterInput = z.object({
  /** The row this phone already has (from its Keychain), to update instead of adding. */
  deviceId: z.string().uuid().optional(),
  platform: z.enum(['IOS', 'ANDROID']),
  pushToken: z.string().trim().min(8).max(400).nullable().optional(),
  deviceName: z.string().trim().max(120).nullable().optional(),
  deviceModel: z.string().trim().max(120).nullable().optional(),
  osVersion: z.string().trim().max(40).nullable().optional(),
  appVersion: z.string().trim().max(40).nullable().optional(),
  /** Ask for a fresh refresh credential (returned once, stored hashed). */
  credential: z.boolean().optional(),
});

/**
 * POST /devices — this phone, for the signed-in person. Re-registering
 * updates the same row (deviceId from the Keychain, or the push token).
 * A push token that belonged to someone else's row (a shared or handed-on
 * phone) moves to this person and the old row is revoked.
 */
nativeAppRouter.post('/devices', requireAuth, async (req: Request, res: Response) => {
  const input = RegisterInput.parse(req.body ?? {});
  const user = req.user!;
  const tenantId = tenantIdForWrite();

  let existing = input.deviceId
    ? await prisma.nativeDevice.findFirst({ where: { id: input.deviceId, userId: user.id, revokedAt: null } })
    : null;
  if (!existing && input.pushToken) {
    const holder = await prisma.nativeDevice.findUnique({ where: { pushToken: input.pushToken } });
    if (holder && holder.userId === user.id && !holder.revokedAt) existing = holder;
    else if (holder) {
      // Someone else's row had this token: the phone changed hands.
      await prisma.nativeDevice.update({ where: { id: holder.id }, data: { pushToken: null, credentialHash: null, revokedAt: new Date() } });
    }
  }
  if (input.pushToken && existing) {
    // The token may also sit on another of this person's rows (a reinstall): clear it there.
    await prisma.nativeDevice.updateMany({ where: { pushToken: input.pushToken, NOT: { id: existing.id } }, data: { pushToken: null } });
  }

  const data = {
    platform: input.platform,
    ...(input.pushToken !== undefined ? { pushToken: input.pushToken } : {}),
    ...(input.deviceName !== undefined ? { deviceName: input.deviceName } : {}),
    ...(input.deviceModel !== undefined ? { deviceModel: input.deviceModel } : {}),
    ...(input.osVersion !== undefined ? { osVersion: input.osVersion } : {}),
    ...(input.appVersion !== undefined ? { appVersion: input.appVersion } : {}),
    lastSeenAt: new Date(),
  };
  const device = existing
    ? await prisma.nativeDevice.update({ where: { id: existing.id }, data })
    : await prisma.nativeDevice.create({ data: { ...data, userId: user.id, tenantId } });

  let credential: string | null = null;
  if (input.credential) {
    const minted = mintCredential(device.id);
    credential = minted.plaintext;
    await prisma.nativeDevice.update({
      where: { id: device.id },
      data: {
        credentialHash: minted.hash,
        credentialExpiresAt: await credentialExpiry(tenantId),
        tokenVersion: user.tokenVersion ?? 0,
        authMethod: req.authMethod ?? 'password',
      },
    });
  }
  if (!existing) {
    enqueueAudit(
      { actorUserId: user.id, action: 'native_device.registered', entityType: 'NativeDevice', entityId: device.id, metadata: { platform: device.platform, model: device.deviceModel } },
      'nativeApp',
    );
  }
  res.status(existing ? 200 : 201).json({ deviceId: device.id, credential });
});

nativeAppRouter.get('/devices', requireAuth, async (req: Request, res: Response) => {
  const current = typeof req.headers['x-alto-device'] === 'string' ? req.headers['x-alto-device'] : null;
  const rows = await prisma.nativeDevice.findMany({
    where: { userId: req.user!.id, revokedAt: null },
    orderBy: { lastSeenAt: 'desc' },
    select: DEVICE_SELECT,
  });
  res.json({ devices: rows.map((d) => deviceView(d, current)) });
});

const PatchInput = z.object({
  pushToken: z.string().trim().min(8).max(400).nullable().optional(),
  biometricLock: z.boolean().optional(),
  appVersion: z.string().trim().max(40).nullable().optional(),
});

nativeAppRouter.patch('/devices/:id', requireAuth, async (req: Request, res: Response) => {
  const id = z.string().uuid().parse(req.params.id);
  const input = PatchInput.parse(req.body ?? {});
  const device = await prisma.nativeDevice.findFirst({ where: { id, userId: req.user!.id, revokedAt: null } });
  if (!device) throw new HttpError(404, 'device_not_found', 'That phone isn’t registered to you.');
  if (input.pushToken) await prisma.nativeDevice.updateMany({ where: { pushToken: input.pushToken, NOT: { id } }, data: { pushToken: null } });
  const updated = await prisma.nativeDevice.update({
    where: { id },
    data: {
      ...(input.pushToken !== undefined ? { pushToken: input.pushToken } : {}),
      ...(input.biometricLock !== undefined ? { biometricLock: input.biometricLock } : {}),
      ...(input.appVersion !== undefined ? { appVersion: input.appVersion } : {}),
      lastSeenAt: new Date(),
    },
    select: DEVICE_SELECT,
  });
  res.json({ device: deviceView(updated, id) });
});

/** DELETE /devices/:id — sign this phone out of push and its Keychain credential. */
nativeAppRouter.delete('/devices/:id', requireAuth, async (req: Request, res: Response) => {
  const id = z.string().uuid().parse(req.params.id);
  const device = await prisma.nativeDevice.findFirst({ where: { id, userId: req.user!.id, revokedAt: null } });
  if (!device) throw new HttpError(404, 'device_not_found', 'That phone isn’t registered to you.');
  await revokeDevice(id);
  enqueueAudit(
    { actorUserId: req.user!.id, action: 'native_device.revoked', entityType: 'NativeDevice', entityId: id, metadata: { platform: device.platform } },
    'nativeApp',
  );
  res.status(204).end();
});

export async function revokeDevice(id: string): Promise<void> {
  await prisma.nativeDevice.update({
    where: { id },
    data: { pushToken: null, credentialHash: null, credentialExpiresAt: null, revokedAt: new Date() },
  });
}

/* ----- Re-open a session from the Keychain -------------------------------- */

const DeviceSessionInput = z.object({ credential: z.string().min(20).max(300) });

/**
 * POST /auth/device-session — { credential } from the phone's Keychain /
 * Keystore (the app only sends it after Face ID / fingerprint when the
 * person turned that on). Valid → a fresh session cookie and a rotated
 * credential; a credential is good once. Refused when the device was
 * revoked, the credential expired, the account is disabled, or the
 * person's sessions were ended (password change, sign out everywhere).
 */
nativeAppRouter.post('/auth/device-session', async (req: Request, res: Response) => {
  const { credential } = DeviceSessionInput.parse(req.body ?? {});
  const parts = credential.split('.');
  const deviceId = parts.length === 3 && parts[0] === 'altodev1' ? parts[1]! : null;
  const fail = () => {
    throw new HttpError(401, 'device_credential_invalid', 'Sign in again on this phone.');
  };
  if (!deviceId || !z.string().uuid().safeParse(deviceId).success) fail();
  const device = await prisma.nativeDevice.findUnique({
    where: { id: deviceId! },
    include: { user: { select: { id: true, role: true, status: true, deletedAt: true, tokenVersion: true, tenantId: true } } },
  });
  if (!device || device.revokedAt || !device.credentialHash || !device.credentialExpiresAt) fail();
  const given = sha256(credential);
  if (given.length !== device!.credentialHash!.length || !timingSafeEqual(given, new Uint8Array(device!.credentialHash!))) fail();
  if (device!.credentialExpiresAt!.getTime() < Date.now()) fail();
  const user = device!.user;
  if (user.deletedAt || user.status !== 'ACTIVE' || user.tokenVersion !== device!.tokenVersion) fail();

  const minted = mintCredential(device!.id);
  await prisma.nativeDevice.update({
    where: { id: device!.id },
    data: { credentialHash: minted.hash, lastSeenAt: new Date() },
  });
  const amr = (['password', 'mfa', 'passkey', 'sso'] as const).includes(device!.authMethod as AuthMethod) ? (device!.authMethod as AuthMethod) : 'password';
  res.cookie(SESSION_COOKIE, signSession({ sub: user.id, role: user.role, ver: user.tokenVersion, amr }), cookieOptions());
  invalidateUserCache(user.id);
  enqueueAudit(
    { actorUserId: user.id, action: 'native_device.session_reopened', entityType: 'NativeDevice', entityId: device!.id, metadata: { platform: device!.platform } },
    'nativeApp',
  );
  res.json({ credential: minted.plaintext });
});

/* ----- System-browser sign-in → the app ----------------------------------- */

/** POST /auth/native-handoff — signed in (in the system browser): a code the app trades for its own session. */
nativeAppRouter.post('/auth/native-handoff', requireAuth, async (req: Request, res: Response) => {
  const code = randomBytes(24).toString('base64url');
  await prisma.nativeHandoffCode.create({
    data: { userId: req.user!.id, tenantId: tenantIdForWrite(), codeHash: sha256(code), expiresAt: new Date(Date.now() + 2 * 60_000) },
  });
  // Housekeeping: codes are worthless after two minutes.
  void prisma.nativeHandoffCode.deleteMany({ where: { expiresAt: { lt: new Date(Date.now() - 3_600_000) } } }).catch(() => {});
  res.json({ code, returnUrl: `altopeople://auth/complete?code=${encodeURIComponent(code)}` });
});

/**
 * GET /auth/native-exchange?code= — the app's web view opens this with the
 * code from the deep link: a session cookie in the app, then home.
 */
nativeAppRouter.get('/auth/native-exchange', async (req: Request, res: Response) => {
  const code = z.string().min(10).max(100).safeParse(req.query.code);
  const toLogin = () => res.redirect(302, '/login?error=handoff_expired');
  if (!code.success) return toLogin();
  // Claimed atomically: a code works once, even if opened twice at the same moment.
  const claimed = await prisma.nativeHandoffCode.updateMany({
    where: { codeHash: sha256(code.data), usedAt: null, expiresAt: { gt: new Date() } },
    data: { usedAt: new Date() },
  });
  if (claimed.count !== 1) return toLogin();
  const row = await prisma.nativeHandoffCode.findUnique({
    where: { codeHash: sha256(code.data) },
    include: { user: { select: { id: true, role: true, status: true, deletedAt: true, tokenVersion: true } } },
  });
  if (!row || row.user.deletedAt || row.user.status !== 'ACTIVE') return toLogin();
  res.cookie(SESSION_COOKIE, signSession({ sub: row.user.id, role: row.user.role, ver: row.user.tokenVersion, amr: 'sso' }), cookieOptions());
  enqueueAudit({ actorUserId: row.user.id, action: 'native_device.handoff_signed_in', entityType: 'User', entityId: row.user.id, metadata: {} }, 'nativeApp');
  return res.redirect(302, '/');
});

/* ----- The worker's badge ------------------------------------------------- */

async function badgeFor(req: Request) {
  const user = req.user!;
  if (!user.associateId) throw new HttpError(404, 'no_badge', 'Badges are for people on the workforce roster.');
  const associate = await prisma.associate.findFirst({
    where: { id: user.associateId, deletedAt: null, deactivatedAt: null },
    select: {
      id: true,
      firstName: true,
      lastName: true,
      photoS3Key: true,
      photoUpdatedAt: true,
      tenantId: true,
      jobProfile: { select: { title: true } },
      kioskPins: { take: 1, select: { id: true, pinEncrypted: true, badgeVersion: true } },
      assignments: { where: { endedAt: null }, orderBy: { startedAt: 'desc' }, take: 1, select: { location: { select: { name: true } } } },
    },
  });
  if (!associate) throw new HttpError(404, 'no_badge', 'Badges are for people on the workforce roster.');
  const pin = associate.kioskPins[0];
  if (!pin) throw new HttpError(409, 'no_clock_in_number', 'You don’t have a clock-in number yet. Ask your supervisor or HR to issue one — your badge follows.');
  const workerNumber = (() => {
    try {
      return pin.pinEncrypted ? decryptString(pin.pinEncrypted) : null;
    } catch {
      return null; // a number issued before encryption: the badge still works without it
    }
  })();
  const token = signBadgeToken({ associateId: associate.id, version: pin.badgeVersion, tenantId: associate.tenantId });
  return {
    associate,
    pin,
    token,
    workerNumber,
    workerName: `${associate.firstName} ${associate.lastName}`.trim(),
    title: associate.jobProfile?.title ?? null,
    siteName: associate.assignments[0]?.location.name ?? null,
    employerName: getBrandingSync(associate.tenantId ?? tenantIdForWrite()).orgName,
  };
}

/** GET /me/wallet/badge — what the badge says, its QR value, and which wallets this deployment can issue to. */
nativeAppRouter.get('/me/wallet/badge', requireAuth, async (req: Request, res: Response) => {
  const b = await badgeFor(req);
  res.json({
    workerName: b.workerName,
    workerNumber: b.workerNumber,
    title: b.title,
    siteName: b.siteName,
    employerName: b.employerName,
    badgeToken: b.token,
    badgeVersion: b.pin.badgeVersion,
    photoUrl: b.associate.photoS3Key ? `/api/associates/${b.associate.id}/photo?v=${b.associate.photoUpdatedAt?.getTime() ?? 0}` : null,
    apple: { available: appleWalletConfigured(), missing: appleWalletConfigured() ? [] : appleWalletMissing() },
    google: { available: googleWalletConfigured(), missing: googleWalletConfigured() ? [] : googleWalletMissing() },
  });
});

async function photoPngs(key: string | null): Promise<{ x1: Buffer | null; x2: Buffer | null }> {
  if (!key) return { x1: null, x2: null };
  try {
    const raw = await getBlobStore().get(key);
    if (!raw) return { x1: null, x2: null };
    const square = (px: number) => sharp(raw).rotate().resize(px, px, { fit: 'cover', position: 'attention' }).png().toBuffer();
    return { x1: await square(90), x2: await square(180) };
  } catch {
    return { x1: null, x2: null };
  }
}

/**
 * A pass download link that works without the session cookie, for five
 * minutes: iOS adds a .pkpass to Wallet only from Safari (or native code),
 * so the app opens this link in the system browser.
 */
const TICKET_MS = 5 * 60_000;
function ticketSecret(): string {
  return createHmac('sha256', env.JWT_SECRET).update('alto-wallet-ticket-v1').digest('hex');
}
function signTicket(userId: string, exp: number): string {
  const payload = Buffer.from(JSON.stringify({ u: userId, e: exp })).toString('base64url');
  const sig = createHmac('sha256', ticketSecret()).update(payload).digest('base64url');
  return `${payload}.${sig}`;
}
function readTicket(t: string): string | null {
  const [payload, sig] = t.split('.');
  if (!payload || !sig) return null;
  const expected = createHmac('sha256', ticketSecret()).update(payload).digest('base64url');
  if (expected.length !== sig.length || !timingSafeEqual(Buffer.from(expected), Buffer.from(sig))) return null;
  try {
    const { u, e } = JSON.parse(Buffer.from(payload, 'base64url').toString()) as { u?: string; e?: number };
    return typeof u === 'string' && typeof e === 'number' && e > Date.now() ? u : null;
  } catch {
    return null;
  }
}

/** POST /me/wallet/badge/apple-link — a five-minute link to the pass (for the system browser). */
nativeAppRouter.post('/me/wallet/badge/apple-link', requireAuth, async (req: Request, res: Response) => {
  if (!appleWalletConfigured()) {
    throw new HttpError(503, 'wallet_not_configured', `Apple Wallet passes aren’t set up yet. An administrator needs to add: ${appleWalletMissing().join(', ')}.`);
  }
  await badgeFor(req); // a person with no badge gets the reason now, not in Safari
  res.json({ url: `${env.APP_BASE_URL}/api/wallet/badge.pkpass?t=${encodeURIComponent(signTicket(req.user!.id, Date.now() + TICKET_MS))}` });
});

/** GET /wallet/badge.pkpass?t= — the pass, for whoever holds a fresh link. */
nativeAppRouter.get('/wallet/badge.pkpass', async (req: Request, res: Response, next) => {
  const userId = typeof req.query.t === 'string' ? readTicket(req.query.t) : null;
  if (!userId) throw new HttpError(410, 'link_expired', 'This link expired. Go back to the app and tap “Add to Apple Wallet” again.');
  const user = await prisma.user.findFirst({ where: { id: userId, deletedAt: null, status: 'ACTIVE' }, select: { id: true, associateId: true } });
  if (!user) throw new HttpError(410, 'link_expired', 'This link expired. Go back to the app and tap “Add to Apple Wallet” again.');
  req.user = { ...(req.user ?? {}), id: user.id, associateId: user.associateId } as typeof req.user;
  return sendPass(req, res).catch(next);
});

/** GET /me/wallet/badge.pkpass — the Apple Wallet pass. */
nativeAppRouter.get('/me/wallet/badge.pkpass', requireAuth, async (req: Request, res: Response) => {
  await sendPass(req, res);
});

async function sendPass(req: Request, res: Response): Promise<void> {
  if (!appleWalletConfigured()) {
    throw new HttpError(503, 'wallet_not_configured', `Apple Wallet passes aren’t set up yet. An administrator needs to add: ${appleWalletMissing().join(', ')}.`);
  }
  const b = await badgeFor(req);
  const photo = await photoPngs(b.associate.photoS3Key);
  const pass = await buildBadgePass({
    serial: `${b.associate.id}-v${b.pin.badgeVersion}`,
    workerName: b.workerName,
    workerNumber: b.workerNumber,
    title: b.title,
    siteName: b.siteName,
    employerName: b.employerName,
    badgeToken: b.token,
    photo1x: photo.x1,
    photo2x: photo.x2,
    issuedAt: new Date(),
    supportUrl: `${env.APP_BASE_URL}/support`,
  });
  enqueueAudit({ actorUserId: req.user!.id, action: 'badge.wallet_issued', entityType: 'Associate', entityId: b.associate.id, metadata: { wallet: 'apple', version: b.pin.badgeVersion } }, 'nativeApp');
  res.setHeader('Content-Type', 'application/vnd.apple.pkpass');
  res.setHeader('Content-Disposition', `attachment; filename="badge.pkpass"`);
  res.setHeader('Cache-Control', 'no-store');
  res.send(pass);
}

/** GET /me/wallet/badge/google — the "Save to Google Wallet" link. */
nativeAppRouter.get('/me/wallet/badge/google', requireAuth, async (req: Request, res: Response) => {
  if (!googleWalletConfigured()) {
    throw new HttpError(503, 'wallet_not_configured', `Google Wallet passes aren’t set up yet. An administrator needs to add: ${googleWalletMissing().join(', ')}.`);
  }
  const b = await badgeFor(req);
  const url = googleSaveUrl({
    objectSuffix: `badge_${b.associate.id}_v${b.pin.badgeVersion}`,
    workerName: b.workerName,
    workerNumber: b.workerNumber,
    title: b.title,
    siteName: b.siteName,
    employerName: b.employerName,
    badgeToken: b.token,
    logoUrl: `${env.APP_BASE_URL}/brand/wallet-logo.png`,
    origins: [env.APP_BASE_URL],
  });
  enqueueAudit({ actorUserId: req.user!.id, action: 'badge.wallet_issued', entityType: 'Associate', entityId: b.associate.id, metadata: { wallet: 'google', version: b.pin.badgeVersion } }, 'nativeApp');
  res.json({ url });
});
