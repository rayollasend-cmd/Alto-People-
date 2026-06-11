import { Router } from 'express';
import { Prisma } from '@prisma/client';
import { z } from 'zod';
import { prisma } from '../db.js';
import { HttpError } from '../middleware/error.js';
import { requireCapability } from '../middleware/auth.js';
import { verifyPassword } from '../lib/passwords.js';
import {
  distanceMeters,
  generateDeviceToken,
  generatePin,
  hashDeviceToken,
  hmacPin,
  isLegacyDeviceHash,
  tokenLookupPrefix,
  verifyDeviceTokenHash,
} from '../lib/kioskAuth.js';
import { enforcePunchRateLimit } from '../lib/kioskRateLimit.js';
import { encryptString, decryptString } from '../lib/crypto.js';
import { enqueueAudit, recordCriticalAudit } from '../lib/audit.js';
import { purgeAssociateBiometrics } from '../lib/kioskMaintenance.js';
import { send } from '../lib/notifications.js';

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

// Both list endpoints below are HR-administrative — they expose device
// metadata and decrypted clock-in PINs. Gate them on manage:time so an
// ASSOCIATE (who has view:time for their own punches) can't enumerate
// other associates' kiosk credentials.
const MANAGE = requireCapability('manage:time');

// ----- Admin: KioskDevice ------------------------------------------------

// Phase 131 — clientId becomes optional when locationId is supplied
// (we derive the client from the Location). At least one must be set.
// The geofence comes from the Location, not the device; per-device
// override was retired in 20260512040000_drop_kiosk_device_geofence.
const DeviceInputSchema = z
  .object({
    clientId: z.string().uuid().optional(),
    locationId: z.string().uuid().optional(),
    name: z.string().min(1).max(120),
  })
  .refine((v) => v.clientId || v.locationId, {
    message: 'clientId or locationId is required',
    path: ['locationId'],
  });

// Token TTL for KioskDevice issuance + rotation. 90 days mirrors how
// often a typical tablet deployment gets touched anyway (battery
// swaps, OS updates, site rotations), so HR's natural cadence catches
// the expiry warning before it fires.
const DEVICE_TOKEN_TTL_DAYS = 90;
function nextTokenExpiry(now: Date = new Date()): Date {
  return new Date(now.getTime() + DEVICE_TOKEN_TTL_DAYS * 24 * 60 * 60 * 1000);
}

kiosk99Router.get('/kiosk-devices', MANAGE, async (req, res) => {
  const clientId = z.string().uuid().optional().parse(req.query.clientId);
  const rows = await prisma.kioskDevice.findMany({
    take: 500,
    where: { ...(clientId ? { clientId } : {}) },
    include: {
      client: { select: { name: true } },
      location: { select: { name: true } },
      _count: { select: { punches: true } },
    },
    orderBy: { createdAt: 'desc' },
  });
  res.json({
    devices: rows.map((d) => ({
      id: d.id,
      clientId: d.clientId,
      clientName: d.client.name,
      locationId: d.locationId,
      locationName: d.location?.name ?? null,
      name: d.name,
      isActive: d.isActive,
      lastSeenAt: d.lastSeenAt?.toISOString() ?? null,
      tokenExpiresAt: d.tokenExpiresAt?.toISOString() ?? null,
      punchCount: d._count.punches,
      createdAt: d.createdAt.toISOString(),
    })),
  });
});

kiosk99Router.post('/kiosk-devices', MANAGE, async (req, res) => {
  const input = DeviceInputSchema.parse(req.body);

  // Phase 131 — resolve the Location (preferred) and infer clientId.
  // KioskDevice.locationId is NOT NULL after PR 3, so a clientId-only
  // request falls back to the client's first active Location.
  let resolvedClientId = input.clientId ?? null;
  let resolvedLocationId: string | null = null;
  if (input.locationId) {
    const location = await prisma.location.findFirst({
      where: { id: input.locationId, deletedAt: null, isActive: true },
      select: { id: true, clientId: true },
    });
    if (!location) {
      throw new HttpError(404, 'location_not_found', 'Location not found or inactive.');
    }
    if (input.clientId && input.clientId !== location.clientId) {
      throw new HttpError(
        400,
        'client_location_mismatch',
        'Location does not belong to the provided client.',
      );
    }
    resolvedClientId = location.clientId;
    resolvedLocationId = location.id;
  } else if (resolvedClientId) {
    const fallback = await prisma.location.findFirst({
      where: { clientId: resolvedClientId, deletedAt: null, isActive: true },
      orderBy: { createdAt: 'asc' },
      select: { id: true },
    });
    if (!fallback) {
      throw new HttpError(
        400,
        'no_location_for_client',
        'Client has no active Location. Add one before registering a kiosk.',
      );
    }
    resolvedLocationId = fallback.id;
  }
  if (!resolvedClientId || !resolvedLocationId) {
    throw new HttpError(400, 'invalid_body', 'clientId or locationId is required.');
  }

  const { plaintext, prefix } = generateDeviceToken();
  const tokenHash = hashDeviceToken(plaintext);
  const created = await prisma.kioskDevice.create({
    data: {
      clientId: resolvedClientId,
      locationId: resolvedLocationId,
      name: input.name,
      tokenHash,
      tokenPrefix: prefix,
      tokenExpiresAt: nextTokenExpiry(),
      createdById: req.user!.id,
    },
  });
  // Plaintext is shown ONCE — paste it into the kiosk's setup screen.
  res.status(201).json({
    id: created.id,
    deviceToken: plaintext,
    tokenExpiresAt: created.tokenExpiresAt?.toISOString() ?? null,
  });
});

// Rotate the device token. Issues a new plaintext (shown once) and
// pushes the expiry forward by another 90 days. Use cases:
//   - HR's quarterly rotation hygiene.
//   - A device is suspected of being compromised.
//   - The "expires in X days" badge in the admin UI is about to flip
//     red and HR wants to keep the kiosk working.
// The old token stops working the moment this returns.
kiosk99Router.post('/kiosk-devices/:id/rotate', MANAGE, async (req, res) => {
  const existing = await prisma.kioskDevice.findUnique({
    where: { id: req.params.id },
    select: { id: true, isActive: true },
  });
  if (!existing) {
    throw new HttpError(404, 'device_not_found', 'Device not found.');
  }
  const { plaintext, prefix } = generateDeviceToken();
  const tokenHash = hashDeviceToken(plaintext);
  const updated = await prisma.kioskDevice.update({
    where: { id: existing.id },
    data: {
      tokenHash,
      tokenPrefix: prefix,
      tokenExpiresAt: nextTokenExpiry(),
      // Fresh 90-day clock → the expiry warnings start over.
      expiryNoticeStage: 0,
    },
    select: { id: true, tokenExpiresAt: true },
  });
  res.json({
    id: updated.id,
    deviceToken: plaintext,
    tokenExpiresAt: updated.tokenExpiresAt?.toISOString() ?? null,
  });
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

// Decrypt a stored employee number, tolerating a row that can't be
// decrypted (e.g. encrypted under a since-rotated key, or seeded in another
// environment). Returns null instead of throwing — otherwise a single bad
// row 500s the whole /kiosk-pins list, which the admin UI swallows and
// renders as "0 with codes", hiding every other associate's code too.
function safeDecrypt(buf: Buffer | null): string | null {
  if (!buf) return null;
  try {
    return decryptString(buf);
  } catch {
    return null;
  }
}

kiosk99Router.get('/kiosk-pins', MANAGE, async (req, res) => {
  // clientId optional — omit it for the cross-client "All clients" view.
  // Scoped per-client it sorts newest-first (matches issuing order); the
  // all-clients view groups by client then name so the flat list stays
  // scannable.
  const clientId = z.string().uuid().optional().parse(req.query.clientId);
  const rows = await prisma.kioskPin.findMany({
    take: 1000,
    where: { ...(clientId ? { clientId } : {}) },
    include: {
      associate: { select: { firstName: true, lastName: true, email: true } },
      client: { select: { name: true } },
    },
    orderBy: clientId
      ? { createdAt: 'desc' }
      : [
          { client: { name: 'asc' } },
          { associate: { lastName: 'asc' } },
          { associate: { firstName: 'asc' } },
        ],
  });

  // Each associate's current worksite (open AssociateAssignment's Location),
  // so HR can filter the list to a single store/location within a client.
  const locByAssoc = new Map<string, { id: string; name: string }>();
  const associateIds = rows.map((r) => r.associateId);
  if (associateIds.length > 0) {
    const assignments = await prisma.associateAssignment.findMany({
      where: { associateId: { in: associateIds }, endedAt: null },
      orderBy: { startedAt: 'desc' },
      select: { associateId: true, location: { select: { id: true, name: true } } },
    });
    for (const a of assignments) {
      if (!locByAssoc.has(a.associateId)) {
        locByAssoc.set(a.associateId, { id: a.location.id, name: a.location.name });
      }
    }
  }

  res.json({
    pins: rows.map((p) => {
      const loc = locByAssoc.get(p.associateId) ?? null;
      return {
        id: p.id,
        associateId: p.associateId,
        associateName: `${p.associate.firstName} ${p.associate.lastName}`,
        associateEmail: p.associate.email,
        clientId: p.clientId,
        clientName: p.client.name,
        locationId: loc?.id ?? null,
        locationName: loc?.name ?? null,
        // Decrypt for HR display. Old rows pre-dating the encryption column,
        // or any row that fails to decrypt, return null — HR rotates to
        // recover the plaintext. safeDecrypt guarantees one bad row can't
        // sink the whole list.
        employeeNumber: safeDecrypt(p.pinEncrypted),
        createdAt: p.createdAt.toISOString(),
      };
    }),
  });
});

// PIN health — early warning that a server secret drifted. For each code we
// can decrypt (PAYOUT_ENCRYPTION_KEY current), we re-HMAC the plaintext with
// the CURRENT KIOSK_PIN_SECRET and compare to the stored hash: a mismatch
// means that code will fail clock-in (the secret changed). Codes we can't
// decrypt at all flag the encryption key drifting. Either way → rotate.
kiosk99Router.get('/kiosk-pins/health', MANAGE, async (req, res) => {
  const clientId = z.string().uuid().optional().parse(req.query.clientId);
  const pins = await prisma.kioskPin.findMany({
    where: { ...(clientId ? { clientId } : {}) },
    select: { pinEncrypted: true, pinHmac: true },
    take: 5000,
  });
  let healthy = 0;
  let unreadable = 0; // can't decrypt → PAYOUT_ENCRYPTION_KEY changed
  let wontClockIn = 0; // decrypts, but hash ≠ current secret → won't match
  let legacy = 0; // pre-encryption rows, no plaintext to verify
  for (const p of pins) {
    if (!p.pinEncrypted) {
      legacy++;
      continue;
    }
    const plaintext = safeDecrypt(p.pinEncrypted);
    if (plaintext === null) {
      unreadable++;
      continue;
    }
    try {
      if (hmacPin(plaintext).equals(p.pinHmac)) healthy++;
      else wontClockIn++;
    } catch {
      wontClockIn++;
    }
  }
  res.json({
    total: pins.length,
    healthy,
    unreadable,
    wontClockIn,
    legacy,
    truncated: pins.length === 5000,
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

// Shared subject + body for the "here is your kiosk number" email, used by
// both the single and bulk send paths so the wording can't drift.
function pinEmailContent(
  firstName: string,
  clientName: string,
  employeeNumber: string,
): { subject: string; body: string } {
  return {
    subject: 'Your Alto kiosk clock-in number',
    body: [
      `Hi ${firstName},`,
      ``,
      `Here is your employee number for clocking in and out at the ${clientName} kiosk:`,
      ``,
      `    ${employeeNumber}`,
      ``,
      `Enter this 4-digit number on the kiosk tablet to clock in and out. You can also see it any time on your My Profile page.`,
      ``,
      `If you didn't expect this email, contact your HR team.`,
      ``,
      `— Alto People`,
    ].join('\n'),
  };
}

// Email an associate their kiosk employee number. HR fires this from the
// "With codes" list so someone who forgot their clock-in number gets it
// without HR reading it aloud. The associate can already see it on their
// My Profile page — this is just a convenience push to their inbox.
kiosk99Router.post('/kiosk-pins/:id/email', MANAGE, async (req, res) => {
  const id = z.string().uuid().parse(req.params.id);
  const pin = await prisma.kioskPin.findUnique({
    where: { id },
    include: {
      associate: { select: { firstName: true, email: true } },
      client: { select: { name: true } },
    },
  });
  if (!pin) {
    throw new HttpError(404, 'not_found', 'Employee number not found.');
  }
  if (!pin.associate.email) {
    throw new HttpError(
      400,
      'no_email',
      'This associate has no email address on file.',
    );
  }
  if (!pin.pinEncrypted) {
    // Legacy row predating the encryption column — we can't recover the
    // plaintext to email. HR must rotate to a fresh number first.
    throw new HttpError(
      409,
      'no_plaintext_number',
      'This number predates encryption — rotate it first to email a fresh one.',
    );
  }

  const { subject, body } = pinEmailContent(
    pin.associate.firstName,
    pin.client.name,
    decryptString(pin.pinEncrypted),
  );

  try {
    await send({
      channel: 'EMAIL',
      recipient: { userId: null, phone: null, email: pin.associate.email },
      subject,
      body,
    });
  } catch {
    throw new HttpError(
      502,
      'email_failed',
      'Could not send the email. Try again in a moment.',
    );
  }

  // Sending a clock-in credential out of the system is worth a trail of
  // who sent it to whom. Fire-and-forget so an audit blip doesn't fail a
  // send that already went out.
  enqueueAudit(
    {
      actorUserId: req.user!.id,
      clientId: pin.clientId,
      action: 'kiosk.pin_emailed',
      entityType: 'KioskPin',
      entityId: pin.id,
      metadata: {
        associateId: pin.associateId,
        recipientEmail: pin.associate.email,
      },
    },
    'kiosk.pin_emailed',
  );

  res.json({ ok: true, email: pin.associate.email });
});

// Bulk variant — email every selected associate their number in one go
// (e.g. a new-site rollout). Mirrors the single send but skips rows that
// can't be emailed (no address, or a legacy number we can't decrypt)
// rather than failing the whole batch.
const BulkEmailSchema = z.object({
  ids: z.array(z.string().uuid()).min(1).max(1000),
});

kiosk99Router.post('/kiosk-pins/email', MANAGE, async (req, res) => {
  const { ids } = BulkEmailSchema.parse(req.body);
  const pins = await prisma.kioskPin.findMany({
    where: { id: { in: ids } },
    include: {
      associate: { select: { firstName: true, email: true } },
      client: { select: { name: true } },
    },
  });

  const emailable = pins.filter((p) => p.associate.email && p.pinEncrypted);
  const skipped = pins.length - emailable.length;
  if (emailable.length === 0) {
    throw new HttpError(
      400,
      'nothing_to_send',
      'None of the selected numbers can be emailed (no address on file, or legacy numbers that need rotating first).',
    );
  }

  const oneSend = (p: (typeof emailable)[number]) => {
    const { subject, body } = pinEmailContent(
      p.associate.firstName,
      p.client.name,
      decryptString(p.pinEncrypted!),
    );
    return send({
      channel: 'EMAIL',
      recipient: { userId: null, phone: null, email: p.associate.email },
      subject,
      body,
    });
  };

  // Await the first send so a misconfigured mailer fails loudly instead of
  // silently dropping the whole batch. The Resend client serializes +
  // throttles internally, so the rest go fire-and-forget and drain in the
  // background — the request stays fast no matter the batch size.
  try {
    await oneSend(emailable[0]!);
  } catch {
    throw new HttpError(
      502,
      'email_failed',
      'Could not send email — check the mail configuration and try again.',
    );
  }
  for (const p of emailable.slice(1)) {
    void oneSend(p).catch(() => {
      /* logged inside send(); one failure shouldn't fail the batch */
    });
  }

  enqueueAudit(
    {
      actorUserId: req.user!.id,
      action: 'kiosk.pins_bulk_emailed',
      entityType: 'KioskPin',
      entityId: emailable[0]!.id,
      metadata: {
        count: emailable.length,
        skipped,
        pinIds: emailable.map((p) => p.id),
      },
    },
    'kiosk.pins_bulk_emailed',
  );

  res.json({ queued: emailable.length, skipped });
});

// HR diagnostic for "wrong PIN" complaints. Given a 4-digit employee
// number, return the full picture: which client the PIN is under,
// which associate it belongs to, that associate's current open shift
// (if any), and the active kiosk devices at the PIN's client + the
// associate's currently-assigned client. The two clients should match;
// when they don't, the PIN was issued before a transfer and needs to
// be re-issued under the associate's current client.
kiosk99Router.get('/kiosk-pins/diagnose', MANAGE, async (req, res) => {
  // Two lookup modes: by 4-digit employee number (HMAC lookup) or by
  // associate name/email substring (case-insensitive). The associate
  // mode is the fallback for "PIN not found" — we resolve the
  // associate by name, then find whatever PIN row points at them.
  const employeeNumber = z
    .string()
    .regex(/^\d{4}$/)
    .optional()
    .parse(req.query.employeeNumber);
  const associateQuery = z
    .string()
    .min(2)
    .max(120)
    .optional()
    .parse(req.query.associate);

  if (!employeeNumber && !associateQuery) {
    throw new HttpError(
      400,
      'invalid_query',
      'Provide either employeeNumber=NNNN or associate=name-or-email.',
    );
  }

  let pin: {
    id: string;
    clientId: string;
    associateId: string;
    pinEncrypted: Buffer | null;
  } | null = null;

  if (employeeNumber) {
    const pinHmac = hmacPin(employeeNumber);
    pin = await prisma.kioskPin.findUnique({
      where: { pinHmac },
      select: { id: true, clientId: true, associateId: true, pinEncrypted: true },
    });
  } else if (associateQuery) {
    const associates = await prisma.associate.findMany({
      where: {
        OR: [
          { firstName: { contains: associateQuery, mode: 'insensitive' } },
          { lastName: { contains: associateQuery, mode: 'insensitive' } },
          { email: { contains: associateQuery, mode: 'insensitive' } },
        ],
      },
      select: { id: true, firstName: true, lastName: true, email: true },
      take: 25,
    });
    if (associates.length === 0) {
      res.json({
        employeeNumber: '',
        matchedPin: null,
        diagnosis: `No associate matches "${associateQuery}". Check the spelling — try first name only, last name only, or email substring.`,
        candidates: [],
      });
      return;
    }
    if (associates.length > 1) {
      res.json({
        employeeNumber: '',
        matchedPin: null,
        diagnosis: `Multiple associates match "${associateQuery}". Pick a more specific query (last name + email substring works best).`,
        candidates: associates.map((a) => ({
          associateId: a.id,
          associateName: `${a.firstName} ${a.lastName}`,
          associateEmail: a.email,
        })),
      });
      return;
    }
    const associate = associates[0]!;
    pin = await prisma.kioskPin.findFirst({
      where: { associateId: associate.id },
      select: { id: true, clientId: true, associateId: true, pinEncrypted: true },
    });
    if (!pin) {
      res.json({
        employeeNumber: '',
        matchedPin: null,
        diagnosis: `Associate "${associate.firstName} ${associate.lastName}" (${associate.email}) exists, but has no kiosk PIN issued. Use the Employee numbers tab to issue one under their currently-assigned client.`,
        candidates: [
          {
            associateId: associate.id,
            associateName: `${associate.firstName} ${associate.lastName}`,
            associateEmail: associate.email,
          },
        ],
      });
      return;
    }
  }

  if (!pin) {
    res.json({
      employeeNumber: employeeNumber ?? '',
      matchedPin: null,
      diagnosis:
        'No PIN row matches this employee number. Either it was never issued, or it was rotated to a different number, or the KIOSK_PIN_SECRET on the server changed since issue (in which case all PINs would be similarly broken — try one other known-good PIN on the kiosk to find out).',
    });
    return;
  }

  const [pinClient, associate, openAssignment, openTimeEntry, devicesAtPinClient] =
    await Promise.all([
      prisma.client.findUnique({
        where: { id: pin.clientId },
        select: { id: true, name: true },
      }),
      prisma.associate.findUnique({
        where: { id: pin.associateId },
        select: { id: true, firstName: true, lastName: true, email: true },
      }),
      prisma.associateAssignment.findFirst({
        where: { associateId: pin.associateId, endedAt: null },
        orderBy: { startedAt: 'desc' },
        include: {
          location: {
            select: {
              id: true,
              name: true,
              clientId: true,
              client: { select: { id: true, name: true } },
            },
          },
        },
      }),
      prisma.timeEntry.findFirst({
        where: { associateId: pin.associateId, status: 'ACTIVE' },
        orderBy: { clockInAt: 'desc' },
        select: {
          id: true,
          clockInAt: true,
          clientId: true,
          locationId: true,
        },
      }),
      prisma.kioskDevice.findMany({
        where: { clientId: pin.clientId, isActive: true },
        select: { id: true, name: true, locationId: true, lastSeenAt: true },
        orderBy: { lastSeenAt: 'desc' },
      }),
    ]);

  const assignmentClientId = openAssignment?.location?.clientId ?? null;
  const clientsMatch =
    assignmentClientId !== null && assignmentClientId === pin.clientId;

  let diagnosis: string;
  if (!openAssignment) {
    diagnosis =
      'PIN exists but the associate has no open AssociateAssignment. Onboarding may be incomplete, or they were offboarded.';
  } else if (!clientsMatch) {
    diagnosis = `MISMATCH: PIN is under client "${pinClient?.name ?? pin.clientId}" but the associate is currently assigned to client "${openAssignment.location.client.name}" (${assignmentClientId}). /kiosk/punch rejects PINs whose clientId differs from the device's clientId, so any tablet registered to the current-assignment client refuses this PIN. Fix: rotate the PIN from the admin (Employee numbers tab → switch to the new client → issue), which creates a new KioskPin row under the right client.`;
  } else {
    diagnosis =
      'PIN and current assignment match. If clock-in is still failing, check that the kiosk device is registered to the same client (Devices tab) and that the device token has not expired.';
  }

  const decryptedNumber = safeDecrypt(pin.pinEncrypted);

  res.json({
    employeeNumber: employeeNumber ?? '',
    matchedPin: {
      id: pin.id,
      pinClientId: pin.clientId,
      pinClientName: pinClient?.name ?? null,
      associateId: pin.associateId,
      associateName: associate
        ? `${associate.firstName} ${associate.lastName}`
        : null,
      associateEmail: associate?.email ?? null,
      currentEmployeeNumber: decryptedNumber,
    },
    currentAssignment: openAssignment
      ? {
          clientId: openAssignment.location.clientId,
          clientName: openAssignment.location.client.name,
          locationId: openAssignment.location.id,
          locationName: openAssignment.location.name,
        }
      : null,
    openTimeEntry: openTimeEntry
      ? {
          id: openTimeEntry.id,
          clockInAt: openTimeEntry.clockInAt.toISOString(),
          clientId: openTimeEntry.clientId,
          locationId: openTimeEntry.locationId,
        }
      : null,
    clientsMatch,
    devicesAtPinClient: devicesAtPinClient.map((d) => ({
      id: d.id,
      name: d.name,
      locationId: d.locationId,
      lastSeenAt: d.lastSeenAt?.toISOString() ?? null,
    })),
    diagnosis,
  });
});

// ----- Forensics --------------------------------------------------------

kiosk99Router.get('/kiosk-punches', MANAGE, async (req, res) => {
  const associateId = z.string().uuid().optional().parse(req.query.associateId);
  const deviceId = z.string().uuid().optional().parse(req.query.deviceId);
  const reviewStatus = z
    .enum(['PENDING', 'APPROVED', 'REJECTED'])
    .optional()
    .parse(req.query.reviewStatus);
  const action = z
    .enum(['CLOCK_IN', 'CLOCK_OUT', 'BREAK_START', 'BREAK_END', 'REJECTED'])
    .optional()
    .parse(req.query.action);
  // Anomalies-only — any punch the system flagged (face mismatch or
  // impossible travel), regardless of where it sits in the review flow.
  const anomaliesOnly = req.query.anomaliesOnly === 'true';
  const from = z
    .string()
    .datetime({ offset: true })
    .optional()
    .parse(req.query.from);
  const to = z
    .string()
    .datetime({ offset: true })
    .optional()
    .parse(req.query.to);
  // 'oldest' surfaces the most stale review-queue items first; HR
  // working the queue wants the back of the line, not the front.
  // Defaults to newest-first to match the existing punch log.
  const sort = z
    .enum(['newest', 'oldest'])
    .optional()
    .parse(req.query.sort);
  // Cursor pagination so the log isn't trapped behind a single 500-row
  // page — a busy multi-client deployment burns through 500 punches in a
  // day or two, and a filter for last month genuinely can't reach past the
  // cap without this. `cursor` is the id of the previous page's last row.
  const cursor = z.string().uuid().optional().parse(req.query.cursor);
  const limit = Math.min(
    Math.max(
      z.coerce.number().int().optional().parse(req.query.limit) ?? 500,
      1,
    ),
    500,
  );

  const dir: Prisma.SortOrder = sort === 'oldest' ? 'asc' : 'desc';
  const where: Prisma.KioskPunchWhereInput = {
    ...(associateId ? { associateId } : {}),
    ...(deviceId ? { kioskDeviceId: deviceId } : {}),
    ...(reviewStatus ? { reviewStatus } : {}),
    ...(action ? { action } : {}),
    ...(anomaliesOnly ? { anomalyKind: { not: null } } : {}),
    ...(from || to
      ? {
          createdAt: {
            ...(from ? { gte: new Date(from) } : {}),
            ...(to ? { lte: new Date(to) } : {}),
          },
        }
      : {}),
  };

  // Peek one row past the page to learn whether there's a next cursor.
  // (createdAt, id) ordering keeps pagination stable across same-timestamp
  // punches.
  const rows = await prisma.kioskPunch.findMany({
    where,
    include: {
      device: { select: { name: true, clientId: true } },
      associate: { select: { firstName: true, lastName: true } },
      reviewedBy: { select: { email: true } },
    },
    orderBy: [{ createdAt: dir }, { id: dir }],
    take: limit + 1,
    ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
  });
  const hasMore = rows.length > limit;
  const page = hasMore ? rows.slice(0, limit) : rows;
  const nextCursor = hasMore ? page[page.length - 1]!.id : null;

  res.json({
    nextCursor,
    punches: page.map((p) => ({
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

// Bulk review — accept up to 50 punch IDs at once so HR can clear a
// backlog of flagged punches without 50 round-trips. Same semantics as
// the single-id endpoint: APPROVED leaves the TimeEntry intact,
// REJECTED voids it. Non-PENDING IDs are skipped (not errored) so a
// stale checkbox doesn't fail the whole batch. Returns per-id outcome
// for the UI to surface.
const BulkReviewSchema = z.object({
  ids: z.array(z.string().uuid()).min(1).max(50),
  decision: z.enum(['APPROVED', 'REJECTED']),
  notes: z.string().max(2000).optional(),
});

kiosk99Router.post('/kiosk-punches/review', MANAGE, async (req, res) => {
  const { ids, decision, notes } = BulkReviewSchema.parse(req.body);
  const punches = await prisma.kioskPunch.findMany({
    where: { id: { in: ids } },
    select: { id: true, timeEntryId: true, reviewStatus: true },
  });
  const byId = new Map(punches.map((p) => [p.id, p]));
  const reviewedAt = new Date();
  const reviewedById = req.user!.id;
  const reviewNotes = notes ?? null;

  let reviewed = 0;
  const skipped: { id: string; reason: 'not_found' | 'not_pending' }[] = [];
  for (const id of ids) {
    const punch = byId.get(id);
    if (!punch) {
      skipped.push({ id, reason: 'not_found' });
      continue;
    }
    if (punch.reviewStatus !== 'PENDING') {
      skipped.push({ id, reason: 'not_pending' });
      continue;
    }
    // Loop one txn per punch — keeps the failure radius small and lets
    // the bulk request succeed-partial. 50 punches × ~30ms ≈ 1.5s, fine
    // for an HR batch action.
    await prisma.$transaction(async (tx) => {
      await tx.kioskPunch.update({
        where: { id: punch.id },
        data: {
          reviewStatus: decision,
          reviewedById,
          reviewedAt,
          reviewNotes,
        },
      });
      if (decision === 'REJECTED' && punch.timeEntryId) {
        await tx.timeEntry.update({
          where: { id: punch.timeEntryId },
          data: {
            status: 'REJECTED',
            notes: notes
              ? `[Voided by review: ${notes}]`
              : '[Voided by kiosk review]',
          },
        });
      }
    });
    reviewed++;
  }
  res.json({ reviewed, skipped });
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

kiosk99Router.get('/kiosk-face-references', MANAGE, async (_req, res) => {
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

// Serve the selfie image. Inline so HR can audit visually. Every view
// is stamped on AuditLog because selfies are biometric data — anyone
// with manage:time can pull them and we want a paper trail of who
// looked at what, when, and from where.
kiosk99Router.get('/kiosk-punches/:id/selfie', MANAGE, async (req, res) => {
  const p = await prisma.kioskPunch.findUnique({
    where: { id: req.params.id },
    select: { selfie: true, associateId: true, kioskDeviceId: true },
  });
  if (!p || !p.selfie) {
    throw new HttpError(404, 'not_found', 'Selfie not found.');
  }
  // Critical: biometric data access. Audit MUST land before we hand the
  // image bytes back, same posture as payout-method reveal.
  await recordCriticalAudit(
    {
      actorUserId: req.user!.id,
      action: 'kiosk.selfie_viewed',
      entityType: 'KioskPunch',
      entityId: req.params.id,
      metadata: {
        associateId: p.associateId,
        kioskDeviceId: p.kioskDeviceId,
        ip: req.ip ?? null,
        userAgent: req.headers['user-agent'] ?? null,
      },
    },
    'kiosk.selfie_viewed',
  );
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

// Phase 131 follow-up — preflight PIN check. The kiosk calls this
// the moment the 4th digit is entered, BEFORE the camera opens. It
// runs the same auth + rate-limit + PIN-match logic as /kiosk/punch
// but doesn't take a selfie, doesn't open a TimeEntry, and doesn't
// record a punch row except on the FAILURE path (which still goes to
// the audit log for brute-force forensics).
//
// Why a separate endpoint instead of just hitting /kiosk/punch with
// no selfie: opening the front camera for an unknown PIN is bad UX
// and a mild info leak (an attacker probing PINs gets to see
// themselves on camera regardless of success). With this preflight,
// the camera only opens for a valid PIN.
const VerifyPinInputSchema = z.object({
  deviceToken: z.string().min(10),
  pin: z.string().regex(/^\d{4}$/, 'PIN must be 4 digits.'),
  latitude: z.number().min(-90).max(90).optional().nullable(),
  longitude: z.number().min(-180).max(180).optional().nullable(),
  // Same intent the punch will carry, so the preflight can predict the
  // action the punch would take ("Clocking you IN") and reject a break
  // toggle from someone who isn't clocked in BEFORE the camera opens.
  intent: z.enum(['BREAK']).optional().nullable(),
});

type PunchAction = 'CLOCK_IN' | 'CLOCK_OUT' | 'BREAK_START' | 'BREAK_END';

/**
 * Read-only mirror of the punch decision tree (see the punch txn below)
 * so the preflight can tell the associate what their punch will do.
 * It's a prediction — the punch re-derives inside its transaction, so a
 * race (e.g. an admin closing the entry between preflight and punch)
 * just makes the greeting wrong for a beat, never the data.
 */
async function predictPunchAction(
  associateId: string,
  intent: 'BREAK' | null,
): Promise<PunchAction | null> {
  const open = await prisma.timeEntry.findFirst({
    where: { associateId, status: 'ACTIVE' },
    orderBy: { clockInAt: 'desc' },
    select: { id: true },
  });
  if (!open) return intent === 'BREAK' ? null : 'CLOCK_IN';
  const openBreak = await prisma.breakEntry.findFirst({
    where: { timeEntryId: open.id, endedAt: null },
    select: { id: true },
  });
  if (intent === 'BREAK') return openBreak ? 'BREAK_END' : 'BREAK_START';
  // No intent: an open break ends the break (inferred — see punch txn),
  // otherwise the entry clocks out.
  return openBreak ? 'BREAK_END' : 'CLOCK_OUT';
}

// Two-stage device lookup, shared by /kiosk/verify-pin and
// /kiosk/punch. Phase 131 hardening — bcrypt-verify is ~5ms per row,
// so scanning every active device per punch costs O(active devices) ×
// 5ms. tokenPrefix is the first 16 chars of the plaintext (stored
// non-secret); the (tokenPrefix, isActive) composite index narrows
// the candidate set to ~1 row. Legacy devices created before the
// prefix migration have NULL tokenPrefix and fall through to a
// bounded scan; after the 90-day token TTL forces global rotation,
// the scan path becomes dead code.
const DEVICE_SCAN_FIELDS = {
  id: true,
  clientId: true,
  locationId: true,
  tokenHash: true,
  tokenExpiresAt: true,
  location: {
    select: {
      latitude: true,
      longitude: true,
      geofenceRadiusMeters: true,
    },
  },
} as const;

type DeviceLookupRow = NonNullable<
  Awaited<ReturnType<typeof findDeviceByPlaintextToken>>
>;

// Match a candidate device row against the plaintext token. Fast path is
// a constant-time keyed-SHA256 compare. Rows still carrying a legacy
// argon2id hash verify the slow way ONCE, then get re-hashed to the fast
// scheme (and backfilled with a tokenPrefix) so every subsequent punch
// skips argon2 and lands on the O(1) lookup path.
async function matchDeviceToken(
  d: { id: string; tokenHash: string },
  plaintext: string,
): Promise<boolean> {
  if (isLegacyDeviceHash(d.tokenHash)) {
    if (await verifyPassword(d.tokenHash, plaintext)) {
      await prisma.kioskDevice.update({
        where: { id: d.id },
        data: {
          tokenHash: hashDeviceToken(plaintext),
          tokenPrefix: tokenLookupPrefix(plaintext),
        },
      });
      return true;
    }
    return false;
  }
  return verifyDeviceTokenHash(d.tokenHash, plaintext);
}

async function findDeviceByPlaintextToken(plaintext: string) {
  const prefix = tokenLookupPrefix(plaintext);
  const fast = await prisma.kioskDevice.findMany({
    where: { isActive: true, tokenPrefix: prefix },
    select: DEVICE_SCAN_FIELDS,
    take: 20,
  });
  for (const d of fast) {
    if (await matchDeviceToken(d, plaintext)) return d;
  }
  const legacy = await prisma.kioskDevice.findMany({
    where: { isActive: true, tokenPrefix: null },
    select: DEVICE_SCAN_FIELDS,
    take: 500,
  });
  for (const d of legacy) {
    if (await matchDeviceToken(d, plaintext)) return d;
  }
  return null;
}

// Lightweight per-device config the tablet fetches once at boot. Today
// it only reports whether this kiosk has a geofence — the tablet uses
// that to decide whether to spin up geolocation AT ALL. A non-geofenced
// kiosk has no reason to wake the GPS radio (slow, especially the first
// fix), so this lets the common case skip location entirely. The server
// still enforces the geofence on punch regardless of what the client does.
const DeviceTokenOnlySchema = z.object({ deviceToken: z.string().min(10) });

kiosk99Router.post('/kiosk/config', async (req, res) => {
  const input = DeviceTokenOnlySchema.parse(req.body);
  const device = await findDeviceByPlaintextToken(input.deviceToken);
  if (!device) {
    throw new HttpError(401, 'invalid_device', 'Device not registered.');
  }
  const geofenceRequired =
    device.location?.latitude != null &&
    device.location?.longitude != null &&
    device.location?.geofenceRadiusMeters != null;
  res.json({
    geofenceRequired,
    tokenExpiresAt: device.tokenExpiresAt?.toISOString() ?? null,
  });
});

kiosk99Router.post('/kiosk/verify-pin', async (req, res) => {
  const input = VerifyPinInputSchema.parse(req.body);

  // Mirror /kiosk/punch's device + expiry + rate-limit chain so the
  // preflight enforces the same auth posture as the real punch.
  const device: DeviceLookupRow | null = await findDeviceByPlaintextToken(
    input.deviceToken,
  );
  if (!device) {
    throw new HttpError(401, 'invalid_device', 'Device not registered.');
  }
  if (device.tokenExpiresAt && device.tokenExpiresAt.getTime() < Date.now()) {
    throw new HttpError(
      401,
      'device_token_expired',
      'This kiosk\'s device token expired. Re-pair from the admin page.',
    );
  }
  // Separate bucket from the punch — see enforcePunchRateLimit. The
  // preflight and the punch it precedes are one clock-in, ~1s apart;
  // sharing a bucket would false-429 the punch.
  enforcePunchRateLimit(device.id, 'preflight');

  // No geofence gate here. Geofence is advisory: the punch itself
  // records distance and flags out-of-fence as an anomaly (kind
  // GEOFENCE) for HR review, but never blocks. A hard block bought no
  // security (coords are client-reported and trivially spoofable) and
  // its location_required dance locked whole sites out of clock-in
  // whenever a tablet's location permission was denied.

  // PIN match — same global HMAC lookup + cross-client safety check.
  const pinHmac = hmacPin(input.pin);
  const pinRow = await prisma.kioskPin.findUnique({
    where: { pinHmac },
    include: {
      associate: {
        select: {
          id: true,
          firstName: true,
          lastName: true,
          faceConsentStatus: true,
        },
      },
    },
  });
  if (!pinRow || pinRow.clientId !== device.clientId) {
    // Two distinct failures that used to both read "Wrong PIN":
    //  - no PIN matches the hash → unrecognized number (or a changed
    //    KIOSK_PIN_SECRET, which makes EVERY pre-rotation PIN stop matching).
    //  - a PIN matches but belongs to a different client than this kiosk →
    //    the associate is at the wrong site / the device is mis-registered.
    // The punch-log reason now tells these apart for diagnosis.
    const wrongSite = !!pinRow && pinRow.clientId !== device.clientId;
    await prisma.kioskPunch.create({
      data: {
        kioskDeviceId: device.id,
        action: 'REJECTED',
        rejectReason: wrongSite
          ? 'pin_wrong_client_preflight'
          : 'pin_not_recognized_preflight',
        clientPunchedAt: new Date(),
      },
    });
    await prisma.kioskDevice.update({
      where: { id: device.id },
      data: { lastSeenAt: new Date() },
    });
    if (wrongSite) {
      throw new HttpError(
        403,
        'wrong_site',
        'This number is registered to a different site. Ask your manager to set up your kiosk site.',
      );
    }
    throw new HttpError(401, 'invalid_pin', 'Wrong PIN.');
  }

  // Predict what the punch will do so the camera screen can say
  // "Clocking you IN, Maria" instead of leaving the direction a mystery
  // until the result screen. A null prediction means the punch would
  // 409 (break toggle while not clocked in) — surface that NOW, at the
  // keypad, instead of after a selfie.
  const predictedAction = await predictPunchAction(
    pinRow.associateId,
    input.intent ?? null,
  );
  if (predictedAction === null) {
    throw new HttpError(
      409,
      'not_clocked_in',
      'You need to clock in before starting a break.',
    );
  }

  res.json({
    ok: true,
    associateFirstName: pinRow.associate.firstName,
    predictedAction,
    // Drives the one-time consent screen: null = never asked (kiosk
    // asks before the first selfie), DECLINED = PIN-only flow (camera
    // never opens), GRANTED = selfie as usual.
    faceConsent: pinRow.associate.faceConsentStatus,
  });
});

// One-time biometric consent, recorded from the kiosk after a valid
// PIN entry. BIPA-style laws require affirmative consent BEFORE
// collecting face geometry, so the tablet asks on the associate's
// first punch (faceConsent === null) and never again. Declining is a
// first-class path: PIN-only punches, no selfie, no descriptor — and
// any biometrics collected under a PREVIOUS grant are scrubbed
// immediately.
const FaceConsentSchema = z.object({
  deviceToken: z.string().min(10),
  pin: z.string().regex(/^\d{4}$/, 'PIN must be 4 digits.'),
  consent: z.boolean(),
});

kiosk99Router.post('/kiosk/face-consent', async (req, res) => {
  const input = FaceConsentSchema.parse(req.body);

  const device = await findDeviceByPlaintextToken(input.deviceToken);
  if (!device) {
    throw new HttpError(401, 'invalid_device', 'Device not registered.');
  }
  if (device.tokenExpiresAt && device.tokenExpiresAt.getTime() < Date.now()) {
    throw new HttpError(
      401,
      'device_token_expired',
      'This kiosk\'s device token expired. Re-pair from the admin page.',
    );
  }
  const pinRow = await prisma.kioskPin.findUnique({
    where: { pinHmac: hmacPin(input.pin) },
    select: { id: true, clientId: true, associateId: true },
  });
  if (!pinRow || pinRow.clientId !== device.clientId) {
    throw new HttpError(401, 'invalid_pin', 'Wrong PIN.');
  }

  const status = input.consent ? 'GRANTED' : 'DECLINED';
  await prisma.associate.update({
    where: { id: pinRow.associateId },
    data: { faceConsentStatus: status, faceConsentAt: new Date() },
  });
  if (!input.consent) {
    // Revocation path — drop anything collected under a prior grant.
    await purgeAssociateBiometrics(prisma, pinRow.associateId);
  }
  // Legally significant record: who, when, from which device.
  enqueueAudit(
    {
      actorUserId: null,
      clientId: device.clientId,
      action: input.consent
        ? 'kiosk.face_consent_granted'
        : 'kiosk.face_consent_declined',
      entityType: 'Associate',
      entityId: pinRow.associateId,
      metadata: { kioskDeviceId: device.id },
    },
    input.consent ? 'kiosk.face_consent_granted' : 'kiosk.face_consent_declined',
  );

  res.json({ ok: true, status });
});

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

  // 1. Resolve device token. Two-stage lookup via the tokenPrefix
  // index — see findDeviceByPlaintextToken above for the rationale.
  // Phase 131 — Location's geofence takes precedence over the
  // per-device override when both are set; the per-device fields stay
  // as a fallback for devices registered before Locations existed.
  const device: DeviceLookupRow | null = await findDeviceByPlaintextToken(
    input.deviceToken,
  );
  if (!device) {
    // Don't leak whether the token format was even right.
    throw new HttpError(401, 'invalid_device', 'Device not registered.');
  }

  // Token expiry — distinct error code so the tablet can self-clear
  // and route back to the setup screen instead of just showing a
  // generic auth error. Devices with NULL tokenExpiresAt (none after
  // the backfill, but the column is nullable for future opt-out) skip
  // the check.
  if (device.tokenExpiresAt && device.tokenExpiresAt.getTime() < Date.now()) {
    throw new HttpError(
      401,
      'device_token_expired',
      'This kiosk\'s device token expired. Re-pair from the admin page.',
    );
  }

  // 1b. Rate limit + brute-force lockout. Throws 429 if the device has
  // punched in the last second, or is in a 5-minute lockout from 3 failed
  // PIN attempts. Runs AFTER device verification (so an attacker can't
  // burn cycles with garbage tokens) but before any DB writes.
  enforcePunchRateLimit(device.id);

  // 2. Geofence — ADVISORY. Record whatever coordinates the tablet sent
  // and, when the device's Location has a fence configured, the distance
  // from its center. Out-of-fence punches still succeed; they're flagged
  // below (anomalyKind GEOFENCE) into the same review queue as face
  // mismatch / impossible travel. A hard block bought no security —
  // coords are client-reported and trivially spoofable — while its
  // failure mode (tablet location permission denied → location_required
  // → nobody at the site can clock in) was very real. Phase 131 —
  // Location is the single geofence source; per-device override columns
  // were dropped in 20260512040000_drop_kiosk_device_geofence.
  const fenceLat = device.location?.latitude
    ? Number(device.location.latitude)
    : null;
  const fenceLng = device.location?.longitude
    ? Number(device.location.longitude)
    : null;
  const fenceRadius = device.location?.geofenceRadiusMeters ?? null;

  const punchLat = input.latitude ?? null;
  const punchLng = input.longitude ?? null;
  let dist: number | null = null;
  let geofenceOutside = false;
  if (
    fenceLat != null &&
    fenceLng != null &&
    fenceRadius != null &&
    punchLat != null &&
    punchLng != null
  ) {
    dist = Math.round(distanceMeters(fenceLat, fenceLng, punchLat, punchLng));
    geofenceOutside = dist > fenceRadius;
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
      associate: {
        select: {
          id: true,
          firstName: true,
          lastName: true,
          faceConsentStatus: true,
        },
      },
    },
  });

  if (!pinRow || pinRow.clientId !== device.clientId) {
    // Two distinct failures, previously both surfaced as "Wrong PIN":
    //  - no PIN matches the hash → unrecognized number (or a changed
    //    KIOSK_PIN_SECRET, which makes EVERY pre-rotation PIN stop matching).
    //  - a PIN matches but belongs to a different client than this kiosk →
    //    the associate is at the wrong site / the device is mis-registered.
    // Distinct reasons so the punch log makes the cause obvious. (We still
    // record a REJECTED row and never hard-lock the shared device.)
    const wrongSite = !!pinRow && pinRow.clientId !== device.clientId;
    await prisma.kioskPunch.create({
      data: {
        kioskDeviceId: device.id,
        action: 'REJECTED',
        rejectReason: wrongSite ? 'pin_wrong_client' : 'pin_not_recognized',
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
    if (wrongSite) {
      throw new HttpError(
        403,
        'wrong_site',
        'This number is registered to a different site. Ask your manager to set up your kiosk site.',
      );
    }
    throw new HttpError(401, 'invalid_pin', 'Wrong PIN.');
  }

  // DECLINED associates punch PIN-only — no photo stored either. (The
  // rejected-PIN path above still keeps its selfie: identity unknown
  // there, and the image is the fraud evidence.)
  const storedSelfie =
    pinRow.associate.faceConsentStatus === 'DECLINED' ? null : selfie;

  // 5 + 5b — the Phase 101 face-reference lookup and the Phase 104
  // impossible-travel lookback both key off this associateId and are
  // independent of each other, so fire them concurrently to save a Neon
  // round-trip on the hot path.
  //
  // Face match is flag-only and never rejects. With the tablet now
  // attaching the descriptor off the critical path (POST
  // /kiosk/punch/:id/face), input.faceDescriptor is usually absent here
  // and the ref lookup is skipped entirely — but offline-queue replays
  // can still carry one, so we keep the inline path.
  //
  // Impossible-travel: if this associate's most recent accepted punch in
  // the last 12h happened on a different kiosk too far to physically
  // reach in the elapsed time, flag for review. Catches "buddy gives you
  // their PIN at site A while you punch at site B".
  const TRAVEL_LOOKBACK_HOURS = 12;
  const TRAVEL_KM_PER_HOUR = 100; // conservative "max ground travel"
  const lookbackSince = new Date(
    Date.now() - TRAVEL_LOOKBACK_HOURS * 3_600_000,
  );
  // Biometric gate: face geometry is only processed (matched OR
  // enrolled) with explicit consent. Unasked (null) and DECLINED both
  // skip — a queued offline punch recorded before consent existed must
  // not enroll anyone.
  const faceAllowed = pinRow.associate.faceConsentStatus === 'GRANTED';
  const [faceRef, prevPunch] = await Promise.all([
    input.faceDescriptor && faceAllowed
      ? prisma.kioskFaceReference.findUnique({
          where: { associateId: pinRow.associateId },
          select: { descriptor: true },
        })
      : Promise.resolve(null),
    prisma.kioskPunch.findFirst({
      where: {
        associateId: pinRow.associateId,
        action: { in: ['CLOCK_IN', 'CLOCK_OUT'] },
        kioskDeviceId: { not: device.id },
        createdAt: { gte: lookbackSince },
      },
      orderBy: { createdAt: 'desc' },
      include: {
        device: {
          select: {
            location: {
              select: { latitude: true, longitude: true },
            },
          },
        },
      },
    }),
  ]);

  let faceDistance: number | null = null;
  let faceMismatch: boolean | null = null;
  let shouldEnrollFace = false;
  let faceReferenceUsed = false;
  if (input.faceDescriptor && faceAllowed) {
    if (faceRef) {
      const refVec = bytesToDescriptor(faceRef.descriptor);
      faceDistance = euclideanDistance(refVec, input.faceDescriptor);
      faceMismatch = faceDistance > FACE_MATCH_THRESHOLD;
      faceReferenceUsed = true;
    } else {
      shouldEnrollFace = true;
    }
  }

  let impossibleTravel: { distKm: number; minutes: number } | null = null;
  // Pick a coordinate for "where this punch happened": prefer the
  // kiosk Location's geofence center (fixed, accurate), fall back to
  // the punch's reported lat/lng for sites without a configured
  // geofence.
  const thisLat =
    device.location?.latitude != null
      ? Number(device.location.latitude)
      : punchLat ?? null;
  const thisLng =
    device.location?.longitude != null
      ? Number(device.location.longitude)
      : punchLng ?? null;
  if (prevPunch && thisLat != null && thisLng != null) {
    const prevLat =
      prevPunch.device.location?.latitude != null
        ? Number(prevPunch.device.location.latitude)
        : prevPunch.punchLat != null
          ? Number(prevPunch.punchLat)
          : null;
    const prevLng =
      prevPunch.device.location?.longitude != null
        ? Number(prevPunch.device.location.longitude)
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
  //
  // Phase 131 hardening — the open-entry lookup runs INSIDE the
  // transaction with a per-associate advisory lock. Without
  // serialization, two punches arriving within milliseconds (HR PIN
  // shared accidentally, double-tap on the keypad, replay attack) both
  // see "no open entry" and create dual CLOCK_INs, or both see the
  // entry and double-update it. pg_advisory_xact_lock is held until
  // commit/rollback and is keyed on the associateId so unrelated
  // associates' punches still parallelize.
  const result = await prisma.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`kiosk_punch:${pinRow.associateId}`}, 0))`;

    const open = await tx.timeEntry.findFirst({
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
      const openBreak = await tx.breakEntry.findFirst({
        where: { timeEntryId: open.id, endedAt: null },
        orderBy: { startedAt: 'desc' },
      });
      if (openBreak) {
        // Inferred break-end. An associate with an open break who
        // punches WITHOUT the break toggle almost always means "I'm
        // back", not "clock me out" — the old behavior silently clocked
        // them out (unpaid for the rest of the shift) whenever they
        // forgot the toggle. Ending the break is the safe reading:
        // worst case someone actually leaving punches once more to
        // clock out, versus losing a half-day of paid time. The
        // preflight predicts this same outcome, so the camera screen
        // already told them "Welcome back".
        await tx.breakEntry.update({
          where: { id: openBreak.id },
          data: { endedAt: at },
        });
        timeEntry = open;
        action = 'BREAK_END';
      } else {
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
      }
    } else {
      timeEntry = await tx.timeEntry.create({
        data: {
          associateId: pinRow.associateId,
          clientId: device.clientId,
          // Phase 131 — snapshot the device's locationId onto the
          // entry so history queries can group by site without
          // chasing the device row.
          locationId: device.locationId,
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
    // is the strongest fraud signal (the user is provably elsewhere), so
    // it wins over face mismatch, which in turn beats the advisory
    // geofence flag (coords are self-reported and a fence miss is
    // usually GPS drift, not fraud). First-enrollment review is the
    // weakest of all — informational, not suspicion.
    let anomalyKind:
      | 'IMPOSSIBLE_TRAVEL'
      | 'FACE_MISMATCH'
      | 'GEOFENCE'
      | 'FACE_ENROLLMENT'
      | null = null;
    let anomalyDetail: string | null = null;
    if (impossibleTravel) {
      anomalyKind = 'IMPOSSIBLE_TRAVEL';
      anomalyDetail = `${impossibleTravel.distKm}km from previous kiosk in ${impossibleTravel.minutes}min`;
    } else if (faceMismatch) {
      anomalyKind = 'FACE_MISMATCH';
      anomalyDetail = `face distance ${faceDistance?.toFixed(3) ?? '?'} > threshold ${FACE_MATCH_THRESHOLD}`;
    } else if (geofenceOutside) {
      anomalyKind = 'GEOFENCE';
      anomalyDetail = `${dist}m from site center, fence radius ${fenceRadius}m`;
    } else if (shouldEnrollFace && input.faceDescriptor) {
      // Trust-on-first-use guard: this punch's descriptor BECOMES the
      // associate's reference template, so an admin should eyeball the
      // selfie once. A day-one buddy-punch otherwise poisons every
      // future match (the imposter reads as "correct" forever).
      anomalyKind = 'FACE_ENROLLMENT';
      anomalyDetail = 'first face enrollment — confirm the selfie matches the associate';
    }

    const punch = await tx.kioskPunch.create({
      data: {
        kioskDeviceId: device.id,
        kioskPinId: pinRow.id,
        associateId: pinRow.associateId,
        timeEntryId: timeEntry.id,
        action,
        selfie: storedSelfie,
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
          lastUsedAt: new Date(),
        },
      });
    } else if (faceReferenceUsed) {
      // Stamp lastUsedAt so the dormant-purge cron knows this template
      // is live. Updating by associateId (unique) so the rare race of
      // "row was deleted by HR mid-punch" no-ops cleanly.
      await tx.kioskFaceReference.updateMany({
        where: { associateId: pinRow.associateId },
        data: { lastUsedAt: new Date() },
      });
    }
    await tx.kioskDevice.update({
      where: { id: device.id },
      data: { lastSeenAt: new Date() },
    });
    return { timeEntry, action, punchId: punch.id };
  }, {
    // The punch txn is ~8 queries behind an advisory lock. On Railway
    // (co-located with Neon) it's tens of ms, but from a far region —
    // local dev, tests — the RTTs alone can blow Prisma's 5s default
    // and 500 a legitimate clock-in. Generous ceiling; the advisory
    // lock already serializes per-associate so length isn't a risk.
    timeout: 15_000,
  });

  res.json({
    action: result.action,
    associateName: `${pinRow.associate.firstName} ${pinRow.associate.lastName}`,
    at: result.timeEntry.updatedAt.toISOString(),
    punchId: result.punchId,
  });
});

// Attach the selfie + face descriptor to a punch AFTER the fact. The
// tablet returns the user to the result screen the instant /kiosk/punch
// responds, then uploads the (large, base64) selfie and computes the
// (CPU-heavy) face descriptor in the background and posts both here.
//
// Why defer the selfie too: it's a ~50-200KB base64 blob, the single
// biggest payload in the flow. Keeping it off the punch request makes the
// clock-in feel instant on a slow uplink — the punch is a few hundred
// bytes and returns immediately, the image follows. Both selfie storage
// and face matching are flag-only / audit-only (they never gate the
// clock-in), so this is best-effort and safe for the client to drop.
//
// NOTE: the OFFLINE path keeps the selfie inline on the queued punch
// (drainQueue has no companion attach call), so offline punches still
// carry their image — only the live path defers it.
const AttachFaceSchema = z.object({
  deviceToken: z.string().min(10),
  // Deferred selfie, base64 data URL or raw — same shape /kiosk/punch takes.
  selfie: z.string().max(2_000_000).optional().nullable(),
  faceDescriptor: z
    .array(z.number().finite())
    .length(128)
    .optional()
    .nullable(),
});

kiosk99Router.post('/kiosk/punch/:id/face', async (req, res) => {
  const punchId = z.string().uuid().parse(req.params.id);
  const input = AttachFaceSchema.parse(req.body);

  const device = await findDeviceByPlaintextToken(input.deviceToken);
  if (!device) {
    throw new HttpError(401, 'invalid_device', 'Device not registered.');
  }

  const punch = await prisma.kioskPunch.findUnique({
    where: { id: punchId },
    select: {
      id: true,
      kioskDeviceId: true,
      associateId: true,
      action: true,
      anomalyKind: true,
      reviewStatus: true,
    },
  });
  // Bind the punch to the calling device and require a real associate —
  // don't leak which check failed.
  if (!punch || punch.kioskDeviceId !== device.id || !punch.associateId) {
    throw new HttpError(404, 'punch_not_found', 'Punch not found.');
  }
  if (punch.action === 'REJECTED') {
    res.json({ ok: true, skipped: true });
    return;
  }
  const associateId = punch.associateId;

  // Biometric gate — same rule as the inline punch path. The tablet
  // shouldn't even capture without GRANTED, but the server is the
  // authority: no consent on record → store nothing, match nothing.
  const associate = await prisma.associate.findUnique({
    where: { id: associateId },
    select: { faceConsentStatus: true },
  });
  if (associate?.faceConsentStatus !== 'GRANTED') {
    res.json({ ok: true, skipped: true });
    return;
  }

  // Store the deferred selfie. Best-effort and independent of the face
  // descriptor: a malformed/oversize image is skipped without aborting the
  // face match below.
  let selfie: Buffer | null = null;
  try {
    selfie = decodeSelfie(input.selfie ?? null);
  } catch {
    /* malformed selfie — skip storing, still attach face */
  }
  if (selfie) {
    await prisma.kioskPunch.update({
      where: { id: punch.id },
      data: { selfie },
    });
  }

  if (!input.faceDescriptor) {
    res.json({ ok: true });
    return;
  }

  const ref = await prisma.kioskFaceReference.findUnique({
    where: { associateId },
    select: { descriptor: true },
  });
  if (!ref) {
    // First sighting — enroll this descriptor as the reference. upsert
    // (not create) so a concurrent first-punch for the same new associate
    // can't trip a P2002 on the unique associateId: the loser just bumps
    // lastUsedAt instead of 500-ing.
    await prisma.kioskFaceReference.upsert({
      where: { associateId },
      create: {
        associateId,
        descriptor: descriptorToBytes(input.faceDescriptor),
        enrolledByPunchId: punch.id,
        lastUsedAt: new Date(),
      },
      update: { lastUsedAt: new Date() },
    });
    // Trust-on-first-use guard (mirrors the inline enroll path): surface
    // the enrolling punch for a one-time human look unless something
    // stronger already flagged it.
    if (punch.anomalyKind == null) {
      await prisma.kioskPunch.update({
        where: { id: punch.id },
        data: {
          anomalyKind: 'FACE_ENROLLMENT',
          anomalyDetail:
            'first face enrollment — confirm the selfie matches the associate',
          reviewStatus: punch.reviewStatus ?? 'PENDING',
        },
      });
    }
    res.json({ ok: true, enrolled: true });
    return;
  }

  const faceDistance = euclideanDistance(
    bytesToDescriptor(ref.descriptor),
    input.faceDescriptor,
  );
  const faceMismatch = faceDistance > FACE_MATCH_THRESHOLD;

  await prisma.$transaction(async (tx) => {
    await tx.kioskFaceReference.updateMany({
      where: { associateId },
      data: { lastUsedAt: new Date() },
    });
    await tx.kioskPunch.update({
      where: { id: punch.id },
      data: {
        faceDistance,
        faceMismatch,
        // Only escalate to a FACE_MISMATCH anomaly when the punch wasn't
        // already flagged for something stronger (impossible-travel wins,
        // mirroring the inline punch logic; face mismatch outranks the
        // advisory GEOFENCE flag and upgrades it). Surface it in the
        // review queue if it isn't already there.
        ...(faceMismatch &&
        (punch.anomalyKind == null || punch.anomalyKind === 'GEOFENCE')
          ? {
              anomalyKind: 'FACE_MISMATCH',
              anomalyDetail: `face distance ${faceDistance.toFixed(3)} > threshold ${FACE_MATCH_THRESHOLD}`,
              reviewStatus: punch.reviewStatus ?? 'PENDING',
            }
          : {}),
      },
    });
  });

  res.json({ ok: true, faceMismatch });
});
