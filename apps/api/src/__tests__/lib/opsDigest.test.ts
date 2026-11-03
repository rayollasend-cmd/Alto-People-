import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { runOpsDigestSweep } from '../../lib/opsDigest.js';
import { flushPendingNotifications } from '../../lib/notify.js';
import { createClient, createUser, prisma, truncateAll } from '../../../test/db.js';

/**
 * The evening store-ops digest goes out once per company day, after 8 PM
 * Eastern. Its repeat check used to look for the day key in the body; the
 * body says the day in words, so it never matched and the office got it
 * every interval until midnight (Nov 2026).
 */

beforeEach(async () => {
  await truncateAll();
});

afterAll(async () => {
  await prisma.$disconnect();
});

// Tue Nov 3 2026, Eastern (UTC-5).
const at = (hhmm: string, day = '2026-11-03') => new Date(`${day}T${hhmm}:00-05:00`);

async function seed(dateKey: string) {
  const client = await createClient();
  const { user: sup } = await createUser({ role: 'SHIFT_SUPERVISOR' });
  await createUser({ role: 'HR_ADMINISTRATOR' });
  await prisma.opsShift.create({
    data: {
      clientId: client.id,
      department: 'Front End',
      departments: ['Front End'],
      period: 'EVENING',
      position: 'Front End Evening',
      dateKey,
      status: 'CLOSED',
      openedById: sup.id,
    },
  });
}

const digests = () => prisma.notification.count({ where: { category: 'ops.digest', channel: 'IN_APP' } });

describe('ops digest', () => {
  it('goes out once a day: the later runs that evening find it already sent', async () => {
    await seed('2026-11-03');

    expect((await runOpsDigestSweep(prisma, at('19:30'))).reason).toBe('before_send_hour');
    expect(await runOpsDigestSweep(prisma, at('20:16'))).toEqual({ sent: true, reason: 'sent' });
    await flushPendingNotifications();
    const once = await digests();
    expect(once).toBeGreaterThan(0);

    for (const hhmm of ['21:16', '22:16', '23:51']) {
      expect(await runOpsDigestSweep(prisma, at(hhmm))).toEqual({ sent: false, reason: 'already_sent' });
    }
    await flushPendingNotifications();
    expect(await digests()).toBe(once);
  });

  it('the next evening sends again', async () => {
    await seed('2026-11-03');
    await seed('2026-11-04');
    expect((await runOpsDigestSweep(prisma, at('20:30'))).sent).toBe(true);
    await flushPendingNotifications();
    const first = await digests();
    expect((await runOpsDigestSweep(prisma, at('20:30', '2026-11-04'))).sent).toBe(true);
    await flushPendingNotifications();
    expect(await digests()).toBe(first * 2);
  });
});
