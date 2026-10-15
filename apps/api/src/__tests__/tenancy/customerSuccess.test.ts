import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { agent, loginAs } from '../../../test/http.js';
import { createUser, prisma, truncateAll } from '../../../test/db.js';
import { flushPendingNotifications } from '../../lib/notify.js';

/**
 * Brief 2-6 step 5 — customer success basics.
 *
 *   A tenant's person asks for help; the platform inbox (the operator's
 *   admins) hears it and answers; the person sees the answer and gets a
 *   bell. Another tenant cannot read the inbox. Release notes: a tenant
 *   reads its own and the platform's, never another tenant's; only the
 *   operator writes platform notes; a tenant edits only its own.
 */

const T2 = '22222222-2222-4222-8222-222222222222';

beforeEach(async () => {
  await truncateAll();
});
afterAll(async () => {
  await prisma.$disconnect();
});

async function hotelAdmin() {
  await prisma.tenant.create({ data: { id: T2, slug: 'acme-hotels', name: 'Acme Hotels', plan: 'standard' } });
  const { user } = await createUser({ role: 'HR_ADMINISTRATOR' });
  await prisma.user.update({ where: { id: user.id }, data: { tenantId: T2 } });
  return { user, a: await loginAs(agent(), user.email) };
}

describe('support requests', () => {
  it('reach the platform inbox and come back answered', async () => {
    const { user: altoAdmin } = await createUser({ role: 'HR_ADMINISTRATOR' });
    const platform = await loginAs(agent(), altoAdmin.email);
    const hotel = await hotelAdmin();

    const asked = await hotel.a.post('/support').send({ category: 'PROBLEM', subject: 'Kiosk will not pair', body: 'The front desk kiosk shows an error on pairing.', pageUrl: '/time-attendance/kiosk', appVersion: '2026.10.15' });
    expect(asked.status).toBe(201);
    await flushPendingNotifications();
    expect(await prisma.notification.count({ where: { recipientUserId: altoAdmin.id, subject: 'Support: Kiosk will not pair' } })).toBe(1);

    const inbox = await platform.get('/support/inbox');
    expect(inbox.body.requests).toEqual([expect.objectContaining({ id: asked.body.id, tenant: 'Acme Hotels', requester: hotel.user.email, status: 'OPEN' })]);
    expect((await hotel.a.get('/support/inbox')).status).toBe(404);

    expect((await platform.patch(`/support/${asked.body.id}`).send({ status: 'RESOLVED', reply: 'Re-issue the pairing code from Kiosk admin.' })).status).toBe(200);
    await flushPendingNotifications();
    const mine = await hotel.a.get('/support/mine');
    expect(mine.body.requests[0]).toMatchObject({ status: 'RESOLVED', reply: 'Re-issue the pairing code from Kiosk admin.' });
    expect(await prisma.notification.count({ where: { recipientUserId: hotel.user.id, subject: 'Resolved: Kiosk will not pair' } })).toBe(1);
  });

  it('the status link is public', async () => {
    const r = await agent().get('/support/config');
    expect(r.status).toBe(200);
    expect(r.body).toHaveProperty('statusPageUrl');
  });
});

describe('release notes', () => {
  it('a tenant reads its own and the platform’s; only the operator writes platform notes; nobody edits another’s', async () => {
    const { user: altoAdmin } = await createUser({ role: 'HR_ADMINISTRATOR' });
    const platform = await loginAs(agent(), altoAdmin.email);
    const hotel = await hotelAdmin();
    const item = (en: string) => ({ audience: 'ALL', en });

    const forAll = await platform.post('/release-notes').send({ day: '2026-10-15', items: [item('Billing by worker type')], published: true, platform: true });
    expect(forAll.status).toBe(201);
    const altoOnly = await platform.post('/release-notes').send({ day: '2026-10-14', items: [item('Alto HR only')], published: true });
    const hotelOnly = await hotel.a.post('/release-notes').send({ day: '2026-10-13', items: [item('Acme only')], published: true });
    expect((await hotel.a.post('/release-notes').send({ day: '2026-10-13', items: [item('x')], published: true, platform: true })).status).toBe(403);

    const seen = (await hotel.a.get('/release-notes')).body.notes.map((n: { id: string }) => n.id);
    expect(seen).toEqual(expect.arrayContaining([forAll.body.note.id, hotelOnly.body.note.id]));
    expect(seen).not.toContain(altoOnly.body.note.id);

    expect((await hotel.a.patch(`/release-notes/${forAll.body.note.id}`).send({ day: '2026-10-15', items: [item('changed')], published: true })).status).toBe(404);
    expect((await hotel.a.delete(`/release-notes/${altoOnly.body.note.id}`)).status).toBe(404);
    expect((await platform.patch(`/release-notes/${forAll.body.note.id}`).send({ day: '2026-10-15', items: [item('Billing by type, corrected')], published: true })).status).toBe(200);
  });
});
