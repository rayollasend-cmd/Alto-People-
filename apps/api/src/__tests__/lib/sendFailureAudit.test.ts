import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { send } from '../../lib/notifications.js';
import { prisma, truncateAll } from '../../../test/db.js';

/**
 * A send that fails must leave a row behind.
 *
 * During the provider quota block, every caller that kept its own
 * Notification row was enumerable afterwards and every caller that didn't
 * was invisible — the mail simply never arrived. `send()` now writes the
 * failure itself unless the caller opts out with `audit: false`, and the
 * row carries the flow's category so an outage reads back as a list of
 * affected flows.
 *
 * The do-not-email list is the failure that needs no provider credentials
 * to reproduce, so it stands in for "the send threw" here.
 */

beforeEach(async () => {
  await truncateAll();
});

afterAll(async () => {
  await prisma.$disconnect();
});

const RECIPIENT = 'blocked@example.com';

async function suppress(): Promise<void> {
  await prisma.emailSuppression.create({
    data: { email: RECIPIENT, reason: 'BOUNCED' },
  });
}

describe('send() failure audit', () => {
  it('records the failed send with its flow category', async () => {
    await suppress();

    await expect(
      send({
        channel: 'EMAIL',
        recipient: { userId: null, phone: null, email: RECIPIENT },
        subject: 'Reset your password',
        body: 'Use this link to reset your password.',
        category: 'password_reset',
      }),
    ).rejects.toThrow();

    const rows = await prisma.notification.findMany();
    expect(rows).toHaveLength(1);
    expect(rows[0].channel).toBe('EMAIL');
    expect(rows[0].recipientEmail).toBe(RECIPIENT);
    expect(rows[0].category).toBe('password_reset');
    expect(rows[0].sentAt).toBeNull();
    // A do-not-email address gets its own status; everything else is FAILED.
    expect(rows[0].status).toBe('SUPPRESSED');
    expect(rows[0].failureReason).toBeTruthy();
  });

  it('writes nothing when the caller keeps its own row', async () => {
    await suppress();

    await expect(
      send({
        channel: 'EMAIL',
        recipient: { userId: null, phone: null, email: RECIPIENT },
        subject: 'Your weekly report',
        body: 'Attached.',
        audit: false,
      }),
    ).rejects.toThrow();

    expect(await prisma.notification.count()).toBe(0);
  });

  it('leaves no row when the send succeeds', async () => {
    // No suppression row, no Resend credentials in test → the stub path
    // returns normally and writes nothing.
    const r = await send({
      channel: 'EMAIL',
      recipient: { userId: null, phone: null, email: 'fine@example.com' },
      subject: 'Hello',
      body: 'Hello.',
      category: 'security_alert',
    });
    expect(r.externalRef).toBeTruthy();
    expect(await prisma.notification.count()).toBe(0);
  });
});
