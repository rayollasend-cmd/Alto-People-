import { afterAll, beforeEach, describe, expect, it, onTestFinished, vi } from 'vitest';
import { createAssociate, createUser, prisma, truncateAll } from '../../../test/db.js';
import { flushPendingNotifications } from '../../lib/notify.js';
import { runExpirationDigest } from '../../lib/expirationDigest.js';
import { ALTO_TENANT_ID, runWithTenant } from '../../lib/tenant.js';

/**
 * The compliance expiration digest goes out once a company day (owner,
 * 2026-11-02). Its cron ticks at boot and then every 24 hours with nothing
 * stored, so each deploy or restart re-sent it — up to 8 copies a day to HR
 * and Ops. The day's own rows are the stamp now, so a second tick the same
 * day (a restart) sends nothing, and the next day sends again.
 */

beforeEach(async () => {
  await truncateAll();
});
afterAll(async () => {
  await prisma.$disconnect();
});

const DAY = 86_400_000;
const runTenant = <T,>(fn: () => Promise<T>) => runWithTenant(ALTO_TENANT_ID, 'job', fn);

function at(iso: string): Date {
  const d = new Date(iso);
  vi.setSystemTime(d);
  return d;
}

async function digestsTo(userId: string): Promise<number> {
  await flushPendingNotifications();
  return prisma.notification.count({ where: { recipientUserId: userId, category: 'compliance.expirations', channel: 'IN_APP' } });
}

describe('the expiration digest, once a day', () => {
  it('sends once on a company day however often it ticks, and again the next day', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    onTestFinished(() => {
      vi.useRealTimers();
    });
    // Wednesday 11 AM in the company's Eastern time.
    const first = at('2026-07-15T15:00:00.000Z');
    const { user: hr } = await createUser({ role: 'HR_ADMINISTRATOR' });
    const ana = await createAssociate({ firstName: 'Ana', lastName: 'Lopez' });
    await prisma.documentRecord.create({
      data: { associateId: ana.id, kind: 'ID', filename: 'id.pdf', mimeType: 'application/pdf', size: 1, status: 'VERIFIED', expiresAt: new Date(first.getTime() - 2.5 * DAY) },
    });

    expect(await runTenant(() => runExpirationDigest(first))).toMatchObject({ notified: 1 });
    expect(await digestsTo(hr.id)).toBe(1);

    // A deploy that afternoon, and another at 10 PM Eastern — already the
    // next day in UTC, still the same company day.
    for (const iso of ['2026-07-15T19:30:00.000Z', '2026-07-16T02:00:00.000Z']) {
      const tick = at(iso);
      expect(await runTenant(() => runExpirationDigest(tick))).toEqual({ notified: 0, skipped: 'already_sent' });
    }
    expect(await digestsTo(hr.id)).toBe(1);

    // The next company day: it goes out again, once.
    const next = at('2026-07-16T15:00:00.000Z');
    expect(await runTenant(() => runExpirationDigest(next))).toMatchObject({ notified: 1 });
    const restart = at('2026-07-16T15:05:00.000Z');
    expect(await runTenant(() => runExpirationDigest(restart))).toMatchObject({ skipped: 'already_sent' });
    expect(await digestsTo(hr.id)).toBe(2);
  });

  it('a day with nothing expiring stamps nothing, so a later tick that day still sends when something is', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    onTestFinished(() => {
      vi.useRealTimers();
    });
    const morning = at('2026-07-15T13:00:00.000Z');
    const { user: hr } = await createUser({ role: 'HR_ADMINISTRATOR' });
    expect(await runTenant(() => runExpirationDigest(morning))).toEqual({ notified: 0 });

    const ana = await createAssociate({ firstName: 'Ana', lastName: 'Lopez' });
    await prisma.documentRecord.create({
      data: { associateId: ana.id, kind: 'ID', filename: 'id.pdf', mimeType: 'application/pdf', size: 1, status: 'VERIFIED', expiresAt: new Date(morning.getTime() - 2 * DAY) },
    });
    const noon = at('2026-07-15T16:00:00.000Z');
    expect(await runTenant(() => runExpirationDigest(noon))).toMatchObject({ notified: 1 });
    expect(await digestsTo(hr.id)).toBe(1);
  });
});
