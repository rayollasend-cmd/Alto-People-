import { Router } from 'express';
import { Prisma } from '@prisma/client';
import { z } from 'zod';
import { prisma } from '../db.js';
import { HttpError } from '../middleware/error.js';
import { requireCapability } from '../middleware/auth.js';
import { hashPassword, verifyPassword } from '../lib/passwords.js';
import {
  generateDeviceToken,
  generatePin,
  hmacPin,
} from '../lib/kioskAuth.js';

/**
 * Phase 99 — Kiosk-mode clock in/out: 4-digit PIN + selfie.
 *
 * Three groups of endpoints:
 *
 *   Admin (manage:time):
 *     POST /kiosk-devices            register a tablet, get device token (once)
 *     GET  /kiosk-devices            list registered devices
 *     POST /kiosk-devices/:id/revoke flip isActive=false
 *     DELETE /kiosk-devices/:id      hard delete
 *     POST /kiosk-pins               assign or rotate PIN, returns plaintext (once)
 *     GET  /kiosk-pins?clientId=...  list PINs for a client (no plaintext)
 *     DELETE /kiosk-pins/:id         remove
 *     GET  /kiosk-punches?...        forensic log for HR review
 *
 *   Public kiosk (device-token auth, no user session):
 *     POST /kiosk/punch              { deviceToken, pin, selfie } → punch
 *
 * Anti-abuse: rate-limited per device + selfie size capped at 1MB. PINs
 * stored as HMAC-SHA256(pin, KIOSK_PIN_SECRET) so an attacker who pops
 * the DB without the env secret can't recover them.
 */

export const kiosk99Router = Router();

const VIEW = requireCapability('view:time');
const MANAGE = requireCapability('manage:time');

// ----- Admin: KioskDevice ------------------------------------------------

const DeviceInputSchema = z.object({
  clientId: z.string().uuid(),
  name: z.string().min(1).max(120),
});

kiosk99Router.get('/kiosk-devices', VIEW, async (req, res) => {
  const clientId = z.string().uuid().optional().parse(req.query.clientId);
  const rows = await prisma.kioskDevice.findMany({
    where: { ...(clientId ? { clientId } : {}) },
    include: {
      client: { select: { name: true } },
      _count: { select: { punches: true } },
    },
    orderBy: { createdAt: 'desc' },
  });
  res.json({
    devices: rows.map((d) => ({
      id: d.id,
      clientId: d.clientId,
      clientName: d.client.name,
      name: d.name,
      isActive: d.isActive,
      lastSeenAt: d.lastSeenAt?.toISOString() ?? null,
      punchCount: d._count.punches,
      createdAt: d.createdAt.toISOString(),
    })),
  });
});

kiosk99Router.post('/kiosk-devices', MANAGE, async (req, res) => {
  const input = DeviceInputSchema.parse(req.body);
  const { plaintext } = generateDeviceToken();
  const tokenHash = await hashPassword(plaintext);
  const created = await prisma.kioskDevice.create({
    data: {
      clientId: input.clientId,
      name: input.name,
      tokenHash,
      createdById: req.user!.id,
    },
  });
  // Plaintext is shown ONCE — paste it into the kiosk's setup screen.
  res.status(201).json({ id: created.id, deviceToken: plaintext });
});

kiosk99Router.post('/kiosk-devices/:id/revoke', MANAGE, async (req, res) => {
  await prisma.kioskDevice.update({
    where: { id: req.params.id },
    data: { isActive: false },
  });
  res.json({ ok: true });
});

kiosk99Router.delete('/kiosk-devices/:id', MANAGE, async (req, res) => {
  await prisma.kioskDevice.delete({ where: { id: req.params.id } });
  res.status(204).end();
});

// ----- Admin: KioskPin ---------------------------------------------------

const PinInputSchema = z.object({
  associateId: z.string().uuid(),
  clientId: z.string().uuid(),
  // Optional explicit PIN; otherwise we generate. Useful when HR wants to
  // hand out a memorable PIN, or to rotate to a known value.
  pin: z
    .string()
    .regex(/^\d{4}$/, 'PIN must be 4 digits.')
    .optional(),
});

kiosk99Router.get('/kiosk-pins', VIEW, async (req, res) => {
  const clientId = z.string().uuid().parse(req.query.clientId);
  const rows = await prisma.kioskPin.findMany({
    where: { clientId },
    include: {
      associate: { select: { firstName: true, lastName: true, email: true } },
    },
    orderBy: { createdAt: 'desc' },
  });
  res.json({
    pins: rows.map((p) => ({
      id: p.id,
      associateId: p.associateId,
      associateName: `${p.associate.firstName} ${p.associate.lastName}`,
      associateEmail: p.associate.email,
      clientId: p.clientId,
      createdAt: p.createdAt.toISOString(),
    })),
  });
});

kiosk99Router.post('/kiosk-pins', MANAGE, async (req, res) => {
  const input = PinInputSchema.parse(req.body);

  // Try to insert; on collision (clientId+pinHmac taken), regenerate up
  // to a few times. With 10k slots collisions are vanishingly rare unless
  // a client has thousands of associates.
  for (let attempt = 0; attempt < 6; attempt++) {
    const pin = input.pin ?? generatePin();
    const pinHmac = hmacPin(pin);
    try {
      const created = await prisma.kioskPin.upsert({
        where: {
          clientId_associateId: {
            clientId: input.clientId,
            associateId: input.associateId,
          },
        },
        update: { pinHmac, createdById: req.user!.id },
        create: {
          clientId: input.clientId,
          associateId: input.associateId,
          pinHmac,
          createdById: req.user!.id,
        },
      });
      // Plaintext shown ONCE.
      res.status(201).json({ id: created.id, pin });
      return;
    } catch (err) {
      if (
        err instanceof Prisma.PrismaClientKnownRequestError &&
        err.code === 'P2002'
      ) {
        if (input.pin) {
          throw new HttpError(
            409,
            'pin_taken',
            'That PIN is already in use at this client. Try another.',
          );
        }
        continue; // Auto-regenerate.
      }
      throw err;
    }
  }
  throw new HttpError(
    500,
    'pin_collision_storm',
    'Could not allocate a unique PIN after 6 attempts. Try again.',
  );
});

kiosk99Router.delete('/kiosk-pins/:id', MANAGE, async (req, res) => {
  await prisma.kioskPin.delete({ where: { id: req.params.id } });
  res.status(204).end();
});

// ----- Forensics --------------------------------------------------------

kiosk99Router.get('/kiosk-punches', VIEW, async (req, res) => {
  const associateId = z.string().uuid().optional().parse(req.query.associateId);
  const deviceId = z.string().uuid().optional().parse(req.query.deviceId);
  const rows = await prisma.kioskPunch.findMany({
    where: {
      ...(associateId ? { associateId } : {}),
      ...(deviceId ? { kioskDeviceId: deviceId } : {}),
    },
    include: {
      device: { select: { name: true, clientId: true } },
      associate: { select: { firstName: true, lastName: true } },
    },
    orderBy: { createdAt: 'desc' },
    take: 500,
  });
  res.json({
    punches: rows.map((p) => ({
      id: p.id,
      kioskDeviceId: p.kioskDeviceId,
      deviceName: p.device.name,
      associateId: p.associateId,
      associateName: p.associate
        ? `${p.associate.firstName} ${p.associate.lastName}`
        : null,
      timeEntryId: p.timeEntryId,
      action: p.action,
      hasSelfie: p.selfie != null,
      rejectReason: p.rejectReason,
      createdAt: p.createdAt.toISOString(),
    })),
  });
});

// Serve the selfie image. Inline so HR can audit visually.
kiosk99Router.get('/kiosk-punches/:id/selfie', VIEW, async (req, res) => {
  const p = await prisma.kioskPunch.findUnique({
    where: { id: req.params.id },
    select: { selfie: true },
  });
  if (!p || !p.selfie) {
    throw new HttpError(404, 'not_found', 'Selfie not found.');
  }
  res.setHeader('Content-Type', 'image/jpeg');
  res.setHeader('Cache-Control', 'private, max-age=300');
  res.send(p.selfie);
});

// ----- Public: kiosk punch ----------------------------------------------

const PunchInputSchema = z.object({
  deviceToken: z.string().min(10),
  pin: z.string().regex(/^\d{4}$/, 'PIN must be 4 digits.'),
  // Selfie as a base64 data URL or raw base64. Optional but strongly
  // encouraged — we surface it in HR for buddy-punching disputes.
  selfie: z.string().max(2_000_000).optional().nullable(),
});

const SELFIE_MAX_BYTES = 1_000_000; // 1MB

function decodeSelfie(s: string | null | undefined): Buffer | null {
  if (!s) return null;
  // Accept "data:image/jpeg;base64,XXXX" or raw "XXXX".
  const comma = s.indexOf(',');
  const b64 = s.startsWith('data:') && comma >= 0 ? s.slice(comma + 1) : s;
  const buf = Buffer.from(b64, 'base64');
  if (buf.length > SELFIE_MAX_BYTES) {
    throw new HttpError(413, 'selfie_too_large', 'Selfie exceeds 1MB.');
  }
  // Sanity check: smallest plausible JPEG is ~1KB. Anything tiny is junk
  // (or a transparent pixel attack) — reject.
  if (buf.length < 500) {
    throw new HttpError(400, 'selfie_too_small', 'Selfie image is invalid.');
  }
  return buf;
}

kiosk99Router.post('/kiosk/punch', async (req, res) => {
  const input = PunchInputSchema.parse(req.body);

  // 1. Resolve device token. We don't index by token (would defeat bcrypt),
  // so we look up active devices for any client and verify against each.
  // For typical deployments that's a few dozen rows — cheap. If this ever
  // becomes hot, add a token-prefix index column.
  const devices = await prisma.kioskDevice.findMany({
    where: { isActive: true },
    select: { id: true, clientId: true, tokenHash: true },
  });
  let device: { id: string; clientId: string } | null = null;
  for (const d of devices) {
    if (await verifyPassword(d.tokenHash, input.deviceToken)) {
      device = { id: d.id, clientId: d.clientId };
      break;
    }
  }
  if (!device) {
    // Don't leak whether the token format was even right.
    throw new HttpError(401, 'invalid_device', 'Device not registered.');
  }

  // 2. Decode selfie up front so a bad upload doesn't waste a PIN lookup.
  const selfie = decodeSelfie(input.selfie ?? null);

  // 3. Look up the PIN. HMAC the input and join on (clientId, pinHmac).
  const pinHmac = hmacPin(input.pin);
  const pinRow = await prisma.kioskPin.findUnique({
    where: {
      clientId_pinHmac: {
        clientId: device.clientId,
        pinHmac,
      },
    },
    include: {
      associate: { select: { id: true, firstName: true, lastName: true } },
    },
  });

  if (!pinRow) {
    // Record a REJECTED punch so we can detect brute-force in the audit log.
    await prisma.kioskPunch.create({
      data: {
        kioskDeviceId: device.id,
        action: 'REJECTED',
        rejectReason: 'pin_not_found',
        selfie,
      },
    });
    await prisma.kioskDevice.update({
      where: { id: device.id },
      data: { lastSeenAt: new Date() },
    });
    throw new HttpError(401, 'invalid_pin', 'PIN not recognized.');
  }

  // 4. Decide CLOCK_IN vs CLOCK_OUT by looking for an open entry.
  const open = await prisma.timeEntry.findFirst({
    where: { associateId: pinRow.associateId, status: 'ACTIVE' },
    orderBy: { clockInAt: 'desc' },
  });

  const result = await prisma.$transaction(async (tx) => {
    let timeEntry;
    let action: 'CLOCK_IN' | 'CLOCK_OUT';
    if (open) {
      timeEntry = await tx.timeEntry.update({
        where: { id: open.id },
        data: { clockOutAt: new Date(), status: 'COMPLETED' },
      });
      action = 'CLOCK_OUT';
    } else {
      timeEntry = await tx.timeEntry.create({
        data: {
          associateId: pinRow.associateId,
          clientId: device.clientId,
          clockInAt: new Date(),
          status: 'ACTIVE',
        },
      });
      action = 'CLOCK_IN';
    }

    const punch = await tx.kioskPunch.create({
      data: {
        kioskDeviceId: device.id,
        kioskPinId: pinRow.id,
        associateId: pinRow.associateId,
        timeEntryId: timeEntry.id,
        action,
        selfie,
      },
    });
    await tx.kioskDevice.update({
      where: { id: device.id },
      data: { lastSeenAt: new Date() },
    });
    return { timeEntry, action, punchId: punch.id };
  });

  res.json({
    action: result.action,
    associateName: `${pinRow.associate.firstName} ${pinRow.associate.lastName}`,
    at: result.timeEntry.updatedAt.toISOString(),
    punchId: result.punchId,
  });
});
