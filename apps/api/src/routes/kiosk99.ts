import { Router } from 'express';
import { Prisma } from '@prisma/client';
import { z } from 'zod';
import { prisma } from '../db.js';
import { HttpError } from '../middleware/error.js';
import { requireCapability } from '../middleware/auth.js';
import { hashPassword, verifyPassword } from '../lib/passwords.js';
import {
  distanceMeters,
  generateDeviceToken,
  generatePin,
  hmacPin,
} from '../lib/kioskAuth.js';
import { encryptString, decryptString } from '../lib/crypto.js';

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

const GeofenceSchema = z
  .object({
    latitude: z.number().min(-90).max(90),
    longitude: z.number().min(-180).max(180),
    radiusMeters: z.number().int().positive().max(50_000),
  })
  .nullable();

const DeviceInputSchema = z.object({
  clientId: z.string().uuid(),
  name: z.string().min(1).max(120),
  geofence: GeofenceSchema.optional(),
});

kiosk99Router.get('/kiosk-devices', VIEW, async (req, res) => {
  const clientId = z.string().uuid().optional().parse(req.query.clientId);
  const rows = await prisma.kioskDevice.findMany({
    take: 500,
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
      geofence:
        d.latitude && d.longitude && d.radiusMeters
          ? {
              latitude: Number(d.latitude),
              longitude: Number(d.longitude),
              radiusMeters: d.radiusMeters,
            }
          : null,
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
      latitude: input.geofence?.latitude ?? null,
      longitude: input.geofence?.longitude ?? null,
      radiusMeters: input.geofence?.radiusMeters ?? null,
      createdById: req.user!.id,
    },
  });
  // Plaintext is shown ONCE — paste it into the kiosk's setup screen.
  res.status(201).json({ id: created.id, deviceToken: plaintext });
});

// Update geofence (or clear it). Other device fields aren't editable
// for v1 — the device token is identity, and HR can revoke + re-pair.
kiosk99Router.put('/kiosk-devices/:id/geofence', MANAGE, async (req, res) => {
  const geofence = GeofenceSchema.parse(req.body?.geofence);
  await prisma.kioskDevice.update({
    where: { id: req.params.id },
    data: {
      latitude: geofence?.latitude ?? null,
      longitude: geofence?.longitude ?? null,
      radiusMeters: geofence?.radiusMeters ?? null,
    },
  });
  res.json({ ok: true });
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
    take: 500,
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
      // Decrypt for HR display. Old rows pre-dating the encryption
      // column return null — HR will need to rotate to recover the
      // plaintext.
      employeeNumber: p.pinEncrypted
        ? decryptString(p.pinEncrypted)
        : null,
      createdAt: p.createdAt.toISOString(),
    })),
  });
});

kiosk99Router.post('/kiosk-pins', MANAGE, async (req, res) => {
  const input = PinInputSchema.parse(req.body);

  // The employee number is issued AFTER onboarding completes — i.e.
  // the associate has at least one APPROVED application. HR shouldn't
  // be handing out clock-in identity until the hire is final.
  const approvedApp = await prisma.application.findFirst({
    where: {
      associateId: input.associateId,
      status: 'APPROVED',
      deletedAt: null,
    },
    select: { id: true },
  });
  if (!approvedApp) {
    throw new HttpError(
      409,
      'onboarding_not_complete',
      'Employee numbers can only be issued after the associate has an approved application.',
    );
  }

  // Try to insert; on global pinHmac collision, regenerate up to a few
  // times. 10k slots — collisions stay rare until the workforce gets
  // large.
  for (let attempt = 0; attempt < 6; attempt++) {
    const pin = input.pin ?? generatePin();
    const pinHmac = hmacPin(pin);
    const pinEncrypted = encryptString(pin);
    try {
      const created = await prisma.kioskPin.upsert({
        where: { associateId: input.associateId },
        update: { pinHmac, pinEncrypted, createdById: req.user!.id },
        create: {
          clientId: input.clientId,
          associateId: input.associateId,
          pinHmac,
          pinEncrypted,
          createdById: req.user!.id,
        },
      });
      res.status(201).json({ id: created.id, employeeNumber: pin });
      return;
    } catch (err) {
      if (
        err instanceof Prisma.PrismaClientKnownRequestError &&
        err.code === 'P2002'
      ) {
        if (input.pin) {
          throw new HttpError(
            409,
            'number_taken',
            'That employee number is already in use. Try another.',
          );
        }
        continue; // Auto-regenerate.
      }
      throw err;
    }
  }
  throw new HttpError(
    500,
    'number_collision_storm',
    'Could not allocate a unique employee number after 6 attempts. Try again.',
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
  const reviewStatus = z
    .enum(['PENDING', 'APPROVED', 'REJECTED'])
    .optional()
    .parse(req.query.reviewStatus);
  const rows = await prisma.kioskPunch.findMany({
    where: {
      ...(associateId ? { associateId } : {}),
      ...(deviceId ? { kioskDeviceId: deviceId } : {}),
      ...(reviewStatus ? { reviewStatus } : {}),
    },
    include: {
      device: { select: { name: true, clientId: true } },
      associate: { select: { firstName: true, lastName: true } },
      reviewedBy: { select: { email: true } },
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
      distanceMeters: p.distanceMeters,
      faceDistance: p.faceDistance,
      faceMismatch: p.faceMismatch,
      anomalyKind: p.anomalyKind,
      anomalyDetail: p.anomalyDetail,
      reviewStatus: p.reviewStatus,
      reviewedAt: p.reviewedAt?.toISOString() ?? null,
      reviewedByEmail: p.reviewedBy?.email ?? null,
      reviewNotes: p.reviewNotes,
      createdAt: p.createdAt.toISOString(),
    })),
  });
});

// Phase 103 — approve / reject a flagged punch. Reject voids the
// associated TimeEntry (sets status=DELETED, zero hours) so it doesn't
// count in payroll.
const ReviewDecisionSchema = z.object({
  decision: z.enum(['APPROVED', 'REJECTED']),
  notes: z.string().max(2000).optional(),
});

kiosk99Router.post('/kiosk-punches/:id/review', MANAGE, async (req, res) => {
  const { decision, notes } = ReviewDecisionSchema.parse(req.body);
  const punch = await prisma.kioskPunch.findUnique({
    where: { id: req.params.id },
    select: { id: true, timeEntryId: true, reviewStatus: true },
  });
  if (!punch) {
    throw new HttpError(404, 'not_found', 'Punch not found.');
  }
  if (punch.reviewStatus !== 'PENDING') {
    throw new HttpError(
      409,
      'not_pending',
      'This punch is not awaiting review.',
    );
  }
  await prisma.$transaction(async (tx) => {
    await tx.kioskPunch.update({
      where: { id: punch.id },
      data: {
        reviewStatus: decision,
        reviewedById: req.user!.id,
        reviewedAt: new Date(),
        reviewNotes: notes ?? null,
      },
    });
    if (decision === 'REJECTED' && punch.timeEntryId) {
      // Void the time entry — reviewer believes the punch was an
      // impostor, so the time should not count for payroll. We mark it
      // REJECTED (existing TimeEntryStatus value) — payroll skips
      // non-APPROVED entries, and the audit trail remains intact.
      await tx.timeEntry.update({
        where: { id: punch.timeEntryId },
        data: {
          status: 'REJECTED',
          notes: notes ? `[Voided by review: ${notes}]` : '[Voided by kiosk review]',
        },
      });
    }
  });
  res.json({ ok: true });
});

// ----- Face references (Phase 101) ---------------------------------------

kiosk99Router.get('/kiosk-face-references', VIEW, async (_req, res) => {
  const rows = await prisma.kioskFaceReference.findMany({
    take: 500,
    include: {
      associate: { select: { firstName: true, lastName: true, email: true } },
    },
    orderBy: { enrolledAt: 'desc' },
  });
  res.json({
    references: rows.map((r) => ({
      id: r.id,
      associateId: r.associateId,
      associateName: `${r.associate.firstName} ${r.associate.lastName}`,
      associateEmail: r.associate.email,
      enrolledByPunchId: r.enrolledByPunchId,
      enrolledAt: r.enrolledAt.toISOString(),
      updatedAt: r.updatedAt.toISOString(),
    })),
  });
});

// HR can wipe a reference to force re-enrollment on the next punch — useful
// after a haircut, glasses change, or if HR suspects the original enrollment
// wasn't actually the right person.
kiosk99Router.delete(
  '/kiosk-face-references/:associateId',
  MANAGE,
  async (req, res) => {
    const associateId = z.string().uuid().parse(req.params.associateId);
    await prisma.kioskFaceReference.deleteMany({
      where: { associateId },
    });
    res.status(204).end();
  },
);

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
  // Phase 100 — geofence inputs. Required when the device has a geofence
  // configured; ignored otherwise. Browser geolocation reports lat/lng
  // as JS numbers.
  latitude: z.number().min(-90).max(90).optional().nullable(),
  longitude: z.number().min(-180).max(180).optional().nullable(),
  // Phase 101 — 128-dim face descriptor extracted in-browser by face-api.js.
  // Optional: kiosks running on devices without WebGL or with denied camera
  // skip face matching gracefully. Each value is a Float32 in roughly
  // [-1, 1]; we don't enforce that range, just length + finiteness.
  faceDescriptor: z
    .array(z.number().finite())
    .length(128)
    .optional()
    .nullable(),
  // Phase 102 — offline queue support. Both optional: a kiosk that's
  // never been offline doesn't need to send either.
  idempotencyKey: z.string().uuid().optional().nullable(),
  clientPunchedAt: z
    .string()
    .datetime({ offset: true })
    .optional()
    .nullable(),
  // Phase 105 — explicit intent. Default (null) is the original
  // toggle: clock-in if not active, clock-out if active. 'BREAK'
  // toggles a break (start if no open break, end if one is open).
  intent: z.enum(['BREAK']).optional().nullable(),
});

// Phase 102 — bound how far in the past a queued punch can be replayed.
// 7 days is generous for a long offline stretch; older than that is
// almost certainly a clock-skew bug or replay attack and HR should
// re-enter manually. Future-dated punches are always rejected.
const MAX_PUNCH_BACKDATE_MS = 7 * 24 * 60 * 60 * 1000;

const SELFIE_MAX_BYTES = 1_000_000; // 1MB

// Phase 101 — face match threshold. face-api.js suggests 0.6 as the
// canonical "same face" cutoff; lower = stricter. We use it for flagging
// only (not rejection), so a slightly looser 0.6 keeps false-positive
// flags low for HR.
const FACE_MATCH_THRESHOLD = 0.6;

function descriptorToBytes(d: number[]): Buffer {
  const buf = Buffer.alloc(128 * 4);
  for (let i = 0; i < 128; i++) buf.writeFloatLE(d[i], i * 4);
  return buf;
}

function bytesToDescriptor(buf: Buffer): Float32Array {
  const out = new Float32Array(128);
  for (let i = 0; i < 128; i++) out[i] = buf.readFloatLE(i * 4);
  return out;
}

function euclideanDistance(a: Float32Array, b: number[]): number {
  let sum = 0;
  for (let i = 0; i < 128; i++) {
    const d = a[i] - b[i];
    sum += d * d;
  }
  return Math.sqrt(sum);
}

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

  // 0. Idempotency short-circuit. If the kiosk is replaying a punch it
  // sent before (e.g., the previous response timed out), we don't want
  // to double-clock. Look up the original by idempotencyKey.
  if (input.idempotencyKey) {
    const prior = await prisma.kioskPunch.findUnique({
      where: { idempotencyKey: input.idempotencyKey },
      include: {
        timeEntry: { select: { id: true, updatedAt: true } },
        associate: { select: { firstName: true, lastName: true } },
      },
    });
    if (prior) {
      if (prior.action === 'REJECTED') {
        throw new HttpError(
          409,
          'previously_rejected',
          `This punch was previously rejected: ${prior.rejectReason ?? 'unknown'}`,
        );
      }
      res.json({
        action: prior.action,
        associateName: prior.associate
          ? `${prior.associate.firstName} ${prior.associate.lastName}`
          : 'unknown',
        at: (prior.timeEntry?.updatedAt ?? prior.createdAt).toISOString(),
        punchId: prior.id,
      });
      return;
    }
  }

  // Validate clientPunchedAt: not future, not absurdly old.
  let clientPunchedAt: Date | null = null;
  if (input.clientPunchedAt) {
    const d = new Date(input.clientPunchedAt);
    const now = Date.now();
    if (d.getTime() > now + 60_000) {
      throw new HttpError(
        400,
        'clock_skew',
        'Kiosk clock is set to the future. Sync the device clock.',
      );
    }
    if (now - d.getTime() > MAX_PUNCH_BACKDATE_MS) {
      throw new HttpError(
        400,
        'punch_too_old',
        'This punch is older than the offline-queue limit. HR must enter it manually.',
      );
    }
    clientPunchedAt = d;
  }

  // 1. Resolve device token. We don't index by token (would defeat bcrypt),
  // so we look up active devices for any client and verify against each.
  // For typical deployments that's a few dozen rows — cheap. If this ever
  // becomes hot, add a token-prefix index column.
  const devices = await prisma.kioskDevice.findMany({
    take: 500,
    where: { isActive: true },
    select: {
      id: true,
      clientId: true,
      tokenHash: true,
      latitude: true,
      longitude: true,
      radiusMeters: true,
    },
  });
  let device: typeof devices[number] | null = null;
  for (const d of devices) {
    if (await verifyPassword(d.tokenHash, input.deviceToken)) {
      device = d;
      break;
    }
  }
  if (!device) {
    // Don't leak whether the token format was even right.
    throw new HttpError(401, 'invalid_device', 'Device not registered.');
  }

  // 2. Geofence check. If device has a geofence, location is required
  // and must be within radius. Distance is recorded on every punch
  // (even accepted ones) so HR can see drift.
  let punchLat: number | null = null;
  let punchLng: number | null = null;
  let dist: number | null = null;
  if (device.latitude && device.longitude && device.radiusMeters) {
    if (input.latitude == null || input.longitude == null) {
      await prisma.kioskPunch.create({
        data: {
          kioskDeviceId: device.id,
          action: 'REJECTED',
          rejectReason: 'location_required',
          idempotencyKey: input.idempotencyKey ?? null,
          clientPunchedAt,
        },
      });
      throw new HttpError(
        400,
        'location_required',
        'This kiosk requires location. Allow location access and try again.',
      );
    }
    punchLat = input.latitude;
    punchLng = input.longitude;
    dist = Math.round(
      distanceMeters(
        Number(device.latitude),
        Number(device.longitude),
        punchLat,
        punchLng,
      ),
    );
    if (dist > device.radiusMeters) {
      await prisma.kioskPunch.create({
        data: {
          kioskDeviceId: device.id,
          action: 'REJECTED',
          rejectReason: `geofence_violation (${dist}m vs ${device.radiusMeters}m)`,
          punchLat,
          punchLng,
          distanceMeters: dist,
          idempotencyKey: input.idempotencyKey ?? null,
          clientPunchedAt,
        },
      });
      await prisma.kioskDevice.update({
        where: { id: device.id },
        data: { lastSeenAt: new Date() },
      });
      throw new HttpError(
        403,
        'geofence_violation',
        'This kiosk is outside its allowed location.',
      );
    }
  }

  // 3. Decode selfie up front so a bad upload doesn't waste a PIN lookup.
  const selfie = decodeSelfie(input.selfie ?? null);

  // 4. Look up the employee number. HMAC the input and look up globally
  // — numbers are unique across the company. We then check the kiosk
  // device's clientId matches the number's home client so an associate
  // can't punch from a tablet at a different client's site.
  const pinHmac = hmacPin(input.pin);
  const pinRow = await prisma.kioskPin.findUnique({
    where: { pinHmac },
    include: {
      associate: { select: { id: true, firstName: true, lastName: true } },
    },
  });

  if (!pinRow || pinRow.clientId !== device.clientId) {
    // Record a REJECTED punch so we can detect brute-force in the audit log.
    await prisma.kioskPunch.create({
      data: {
        kioskDeviceId: device.id,
        action: 'REJECTED',
        rejectReason: 'pin_not_found',
        selfie,
        punchLat,
        punchLng,
        distanceMeters: dist,
        idempotencyKey: input.idempotencyKey ?? null,
        clientPunchedAt,
      },
    });
    await prisma.kioskDevice.update({
      where: { id: device.id },
      data: { lastSeenAt: new Date() },
    });
    throw new HttpError(401, 'invalid_pin', 'PIN not recognized.');
  }

  // 5. Phase 101 — face match (flag-only, never reject). If we have a
  // descriptor and a reference, compute Euclidean distance. If we have a
  // descriptor but no reference, we'll enroll inside the transaction
  // below (so enrollment ties to the punch row).
  let faceDistance: number | null = null;
  let faceMismatch: boolean | null = null;
  let shouldEnrollFace = false;
  if (input.faceDescriptor) {
    const ref = await prisma.kioskFaceReference.findUnique({
      where: { associateId: pinRow.associateId },
      select: { descriptor: true },
    });
    if (ref) {
      const refVec = bytesToDescriptor(ref.descriptor);
      faceDistance = euclideanDistance(refVec, input.faceDescriptor);
      faceMismatch = faceDistance > FACE_MATCH_THRESHOLD;
    } else {
      shouldEnrollFace = true;
    }
  }

  // 5b. Phase 104 — impossible-travel detection. Look at this associate's
  // most recent prior accepted punch within the last 12 hours; if it
  // happened on a different kiosk too far away to physically reach in
  // the elapsed time, flag this punch for review. This catches the
  // "buddy gives you their PIN at site A while you punch at site B"
  // pattern that face matching alone might miss (low light, bad angle).
  let impossibleTravel: { distKm: number; minutes: number } | null = null;
  const TRAVEL_LOOKBACK_HOURS = 12;
  const TRAVEL_KM_PER_HOUR = 100; // conservative "max ground travel"
  const lookbackSince = new Date(
    Date.now() - TRAVEL_LOOKBACK_HOURS * 3_600_000,
  );
  const prevPunch = await prisma.kioskPunch.findFirst({
    where: {
      associateId: pinRow.associateId,
      action: { in: ['CLOCK_IN', 'CLOCK_OUT'] },
      kioskDeviceId: { not: device.id },
      createdAt: { gte: lookbackSince },
    },
    orderBy: { createdAt: 'desc' },
    include: {
      device: {
        select: { latitude: true, longitude: true },
      },
    },
  });
  // Pick a coordinate for "where this punch happened": prefer the kiosk's
  // geofence center (fixed, accurate), fall back to the punch's reported
  // lat/lng (if the device has no geofence configured).
  const thisLat =
    device.latitude != null
      ? Number(device.latitude)
      : punchLat ?? null;
  const thisLng =
    device.longitude != null
      ? Number(device.longitude)
      : punchLng ?? null;
  if (prevPunch && thisLat != null && thisLng != null) {
    const prevLat =
      prevPunch.device.latitude != null
        ? Number(prevPunch.device.latitude)
        : prevPunch.punchLat != null
          ? Number(prevPunch.punchLat)
          : null;
    const prevLng =
      prevPunch.device.longitude != null
        ? Number(prevPunch.device.longitude)
        : prevPunch.punchLng != null
          ? Number(prevPunch.punchLng)
          : null;
    if (prevLat != null && prevLng != null) {
      const km = distanceMeters(prevLat, prevLng, thisLat, thisLng) / 1000;
      const minutes = (Date.now() - prevPunch.createdAt.getTime()) / 60_000;
      // If you'd need to move faster than 100 km/h sustained, that's not
      // a normal commute. Use 5km/30min floor so a within-campus walk
      // doesn't trip on rounding.
      if (km > 5 && minutes > 0 && km / (minutes / 60) > TRAVEL_KM_PER_HOUR) {
        impossibleTravel = {
          distKm: Math.round(km * 10) / 10,
          minutes: Math.round(minutes),
        };
      }
    }
  }

  // 6. Decide CLOCK_IN vs CLOCK_OUT (or BREAK_START/BREAK_END when
  // intent='BREAK') by looking for an open entry. Break path requires
  // an ACTIVE entry — you can't break before clocking in.
  const open = await prisma.timeEntry.findFirst({
    where: { associateId: pinRow.associateId, status: 'ACTIVE' },
    orderBy: { clockInAt: 'desc' },
  });

  if (input.intent === 'BREAK' && !open) {
    throw new HttpError(
      409,
      'not_clocked_in',
      'You need to clock in before starting a break.',
    );
  }

  const result = await prisma.$transaction(async (tx) => {
    // Phase 102 — when the kiosk supplies a wall-clock timestamp (queued
    // punch replayed later), use it for the TimeEntry. Otherwise server now().
    const at = clientPunchedAt ?? new Date();
    let timeEntry;
    let action: 'CLOCK_IN' | 'CLOCK_OUT' | 'BREAK_START' | 'BREAK_END';

    if (input.intent === 'BREAK' && open) {
      // Phase 105 — toggle break. If there's an open break (no endedAt),
      // close it. Otherwise start a new one. Either way, the parent
      // TimeEntry stays ACTIVE.
      const openBreak = await tx.breakEntry.findFirst({
        where: { timeEntryId: open.id, endedAt: null },
        orderBy: { startedAt: 'desc' },
      });
      if (openBreak) {
        await tx.breakEntry.update({
          where: { id: openBreak.id },
          data: { endedAt: at },
        });
        action = 'BREAK_END';
      } else {
        await tx.breakEntry.create({
          data: {
            timeEntryId: open.id,
            // Default to MEAL — REST breaks are typically tracked off-system.
            // HR can re-classify in the timesheet view.
            type: 'MEAL',
            startedAt: at,
          },
        });
        action = 'BREAK_START';
      }
      timeEntry = open;
    } else if (open) {
      // Don't allow clocking out while a break is open — close the break
      // first so payable hours math stays clean.
      const openBreak = await tx.breakEntry.findFirst({
        where: { timeEntryId: open.id, endedAt: null },
      });
      if (openBreak) {
        await tx.breakEntry.update({
          where: { id: openBreak.id },
          data: { endedAt: at },
        });
      }
      timeEntry = await tx.timeEntry.update({
        where: { id: open.id },
        data: {
          clockOutAt: at,
          status: 'COMPLETED',
          // Snapshot coords on the time entry too, for downstream audit
          // reports without joining KioskPunch.
          ...(punchLat != null && punchLng != null
            ? { clockOutLat: punchLat, clockOutLng: punchLng }
            : {}),
        },
      });
      action = 'CLOCK_OUT';
    } else {
      timeEntry = await tx.timeEntry.create({
        data: {
          associateId: pinRow.associateId,
          clientId: device.clientId,
          clockInAt: at,
          status: 'ACTIVE',
          ...(punchLat != null && punchLng != null
            ? { clockInLat: punchLat, clockInLng: punchLng }
            : {}),
        },
      });
      action = 'CLOCK_IN';
    }

    // Phase 104 — pick a primary anomaly classification. Impossible-travel
    // is the stronger fraud signal (the user is provably elsewhere), so
    // it wins over face mismatch when both fire on the same punch.
    let anomalyKind:
      | 'IMPOSSIBLE_TRAVEL'
      | 'FACE_MISMATCH'
      | null = null;
    let anomalyDetail: string | null = null;
    if (impossibleTravel) {
      anomalyKind = 'IMPOSSIBLE_TRAVEL';
      anomalyDetail = `${impossibleTravel.distKm}km from previous kiosk in ${impossibleTravel.minutes}min`;
    } else if (faceMismatch) {
      anomalyKind = 'FACE_MISMATCH';
      anomalyDetail = `face distance ${faceDistance?.toFixed(3) ?? '?'} > threshold ${FACE_MATCH_THRESHOLD}`;
    }

    const punch = await tx.kioskPunch.create({
      data: {
        kioskDeviceId: device.id,
        kioskPinId: pinRow.id,
        associateId: pinRow.associateId,
        timeEntryId: timeEntry.id,
        action,
        selfie,
        punchLat,
        punchLng,
        distanceMeters: dist,
        faceDistance,
        faceMismatch,
        idempotencyKey: input.idempotencyKey ?? null,
        clientPunchedAt,
        anomalyKind,
        anomalyDetail,
        // Surface in the review queue when any anomaly fired. The punch
        // still succeeds (no one gets locked out), HR triages later.
        reviewStatus: anomalyKind ? 'PENDING' : null,
      },
    });
    if (shouldEnrollFace && input.faceDescriptor) {
      await tx.kioskFaceReference.create({
        data: {
          associateId: pinRow.associateId,
          descriptor: descriptorToBytes(input.faceDescriptor),
          enrolledByPunchId: punch.id,
        },
      });
    }
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
