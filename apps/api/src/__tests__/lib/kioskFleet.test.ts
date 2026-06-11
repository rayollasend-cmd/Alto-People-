import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import {
  sendKioskFleetNotices,
  SILENT_DEVICE_AFTER_HOURS,
} from '../../lib/kioskMaintenance.js';
import { generateDeviceToken, hashDeviceToken } from '../../lib/kioskAuth.js';
import { createClient, createUser, prisma, truncateAll } from '../../../test/db.js';

const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;

async function makeDevice(opts: {
  name: string;
  tokenExpiresAt?: Date | null;
  lastSeenAt?: Date | null;
}) {
  const client = await createClient();
  const location = await prisma.location.findFirstOrThrow({
    where: { clientId: client.id },
  });
  const { plaintext, prefix } = generateDeviceToken();
  return prisma.kioskDevice.create({
    data: {
      clientId: client.id,
      locationId: location.id,
      name: opts.name,
      tokenHash: hashDeviceToken(plaintext),
      tokenPrefix: prefix,
      tokenExpiresAt: opts.tokenExpiresAt ?? null,
      lastSeenAt: opts.lastSeenAt ?? null,
    },
  });
}

beforeEach(async () => {
  await truncateAll();
});

afterAll(async () => {
  await prisma.$disconnect();
});

describe('sendKioskFleetNotices', () => {
  it('notices expiring tokens and silent devices once, with per-device dedup', async () => {
    const now = new Date();
    await createUser({ role: 'HR_ADMINISTRATOR' });

    // 10 days out → 14-day warning (stage 1).
    const warn = await makeDevice({
      name: 'Front door',
      tokenExpiresAt: new Date(now.getTime() + 10 * DAY),
      lastSeenAt: now,
    });
    // 2 days out → final warning (stage 2) directly.
    const backOffice = await makeDevice({
      name: 'Back office',
      tokenExpiresAt: new Date(now.getTime() + 2 * DAY),
      lastSeenAt: now,
    });
    // Quiet for twice the threshold → silent notice.
    const quiet = await makeDevice({
      name: 'Break room',
      tokenExpiresAt: new Date(now.getTime() + 80 * DAY),
      lastSeenAt: new Date(now.getTime() - 2 * SILENT_DEVICE_AFTER_HOURS * HOUR),
    });
    // Never seen (spare tablet) → must NOT nag.
    await makeDevice({
      name: 'Spare',
      tokenExpiresAt: new Date(now.getTime() + 80 * DAY),
      lastSeenAt: null,
    });

    const first = await sendKioskFleetNotices(prisma, now);
    expect(first.expiringNotices).toBe(2);
    expect(first.silentNotices).toBe(1);
    expect(first.adminsEmailed).toBe(1);

    // Same conditions again → everything deduped.
    const second = await sendKioskFleetNotices(prisma, now);
    expect(second).toEqual({ expiringNotices: 0, silentNotices: 0, adminsEmailed: 0 });

    // The 14-day-warned device crosses the 3-day mark → escalates once.
    await prisma.kioskDevice.update({
      where: { id: warn.id },
      data: { tokenExpiresAt: new Date(now.getTime() + 2 * DAY) },
    });
    const third = await sendKioskFleetNotices(prisma, now);
    expect(third.expiringNotices).toBe(1);
    expect(third.silentNotices).toBe(0);

    // The quiet device comes back, then goes quiet again → re-noticed.
    // Keep the other two devices "fresh" at the later timestamp so this
    // asserts exactly the re-notice, not their own first silence.
    await prisma.kioskDevice.update({
      where: { id: quiet.id },
      data: { lastSeenAt: new Date(now.getTime() + 1 * HOUR) },
    });
    const later = new Date(
      now.getTime() + 1 * HOUR + (SILENT_DEVICE_AFTER_HOURS + 1) * HOUR,
    );
    await prisma.kioskDevice.updateMany({
      where: { id: { in: [warn.id, backOffice.id] } },
      data: { lastSeenAt: later },
    });
    const fourth = await sendKioskFleetNotices(prisma, later);
    expect(fourth.silentNotices).toBe(1);
  });
});
