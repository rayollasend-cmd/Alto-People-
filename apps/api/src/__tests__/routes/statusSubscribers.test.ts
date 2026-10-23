import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import { createApp } from '../../app.js';
import { prisma, truncateAll } from '../../../test/db.js';
import { notifyStatusSubscribers, statusLinkToken } from '../../lib/statusSubscribers.js';

/**
 * Incident updates by email from the public status page (F500 G5): double
 * opt-in, the same answer whether or not an address was already listed,
 * signed links that can't be swapped (a confirm link doesn't unsubscribe),
 * and updates only to confirmed addresses.
 */

const app = () => createApp();
beforeEach(async () => {
  await truncateAll();
});
afterAll(async () => {
  await prisma.$disconnect();
});

describe('status updates by email', () => {
  it('subscribes unconfirmed, confirms from the signed link, and only then sends', async () => {
    const r = await request(app()).post('/status/subscribe').send({ email: 'Buyer@Example.com' });
    expect(r.status).toBe(202);
    // Asking twice answers the same and keeps one row.
    expect((await request(app()).post('/status/subscribe').send({ email: 'buyer@example.com' })).status).toBe(202);
    const rows = await prisma.statusSubscriber.findMany();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ email: 'buyer@example.com', confirmedAt: null });

    const incident = { title: 'Kiosk punches failing', component: 'KIOSK', impact: 'OUTAGE', state: 'INVESTIGATING', note: 'Looking into it.' };
    expect(await notifyStatusSubscribers(prisma, incident)).toBe(0);

    // A confirm link can't unsubscribe, and a forged one confirms nothing.
    expect((await request(app()).post('/status/unsubscribe').send({ token: statusLinkToken('confirm', rows[0]!.id) })).status).toBe(404);
    expect((await request(app()).post('/status/subscribe/confirm').send({ token: `${rows[0]!.id}.forged-signature-xx` })).status).toBe(404);
    expect((await request(app()).post('/status/subscribe/confirm').send({ token: statusLinkToken('confirm', rows[0]!.id) })).status).toBe(200);
    expect((await prisma.statusSubscriber.findFirstOrThrow()).confirmedAt).not.toBeNull();
    expect(await notifyStatusSubscribers(prisma, incident)).toBe(1);

    expect((await request(app()).post('/status/unsubscribe').send({ token: statusLinkToken('unsubscribe', rows[0]!.id) })).status).toBe(200);
    expect(await prisma.statusSubscriber.count()).toBe(0);
    expect(await notifyStatusSubscribers(prisma, incident)).toBe(0);
  });

  it('refuses an address that isn’t one', async () => {
    expect((await request(app()).post('/status/subscribe').send({ email: 'not-an-email' })).status).toBe(400);
  });
});
