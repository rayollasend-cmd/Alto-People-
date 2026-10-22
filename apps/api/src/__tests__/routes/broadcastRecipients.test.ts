import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { agent, loginAs } from '../../../test/http.js';
import { createAssociate, createClient, createUser, prisma, truncateAll } from '../../../test/db.js';
import { flushPendingNotifications } from '../../lib/notify.js';

/**
 * "Message selected" on People (HR walk, wave 2): the one broadcast
 * composer with an explicit list of people. The list reaches exactly those
 * people — still only the active ones in the sender's reach — on the
 * chosen channels, and a channel with no provider says so.
 */

beforeEach(async () => {
  await truncateAll();
});
afterAll(async () => {
  await prisma.$disconnect();
});

async function world() {
  const c = await createClient('Coastal');
  const north = await prisma.site.findFirstOrThrow({ where: { clientId: c.id } });
  const south = await prisma.site.create({ data: { clientId: c.id, name: 'South' } });
  const people = [];
  for (const [first, site, phone] of [['Ana', north.id, '(555) 010-0101'], ['Ben', north.id, null], ['Cy', south.id, '(555) 010-0103'], ['Dee', north.id, null]] as const) {
    const p = await createAssociate({ firstName: first, lastName: 'Test' });
    await prisma.associate.update({ where: { id: p.id }, data: { phone } });
    await prisma.associateAssignment.create({ data: { associateId: p.id, locationId: site, startedAt: new Date('2026-01-01') } });
    const { user } = await createUser({ role: 'ASSOCIATE', email: p.email, associateId: p.id });
    people.push({ ...p, userId: user.id });
  }
  return { c, north, south, people };
}

describe('a broadcast to the people picked on People', () => {
  it('reaches exactly the list, counts it before sending, and keeps it on the draft', async () => {
    const { people } = await world();
    const [ana, ben, , dee] = people;
    const { user: hr } = await createUser({ role: 'HR_ADMINISTRATOR' });
    const a = await loginAs(agent(), hr.email);

    const count = await a.post('/broadcasts/audience-count').send({ recipientAssociateIds: [ana!.id, ben!.id] });
    expect(count.body).toMatchObject({ people: 2, withAccount: 2, withPhone: 1 });

    const created = await a.post('/broadcasts').send({ title: 'Your badge is ready', body: 'Pick it up at the front desk.', channels: ['IN_APP', 'SMS'], recipientAssociateIds: [ana!.id, ben!.id, ana!.id] });
    expect(created.status).toBe(201);
    const list = await a.get('/broadcasts');
    expect(list.body.broadcasts[0].recipientAssociateIds.sort()).toEqual([ana!.id, ben!.id].sort());
    expect((await a.get(`/broadcasts/${created.body.id}/audience-count`)).body.people).toBe(2);

    const sent = await a.post(`/broadcasts/${created.body.id}/send`);
    expect(sent.status).toBe(200);
    expect(sent.body.recipientCount).toBe(2);
    // No texting provider in tests: said up front, never counted as sent.
    expect(sent.body.notConfigured).toMatchObject({ SMS: expect.any(String) });
    await flushPendingNotifications();
    const receipts = await prisma.broadcastReceipt.findMany({ where: { broadcastId: created.body.id } });
    expect(receipts.map((r) => r.userId).sort()).toEqual([ana!.userId, ben!.userId].sort());
    expect(receipts.some((r) => r.userId === dee!.userId)).toBe(false);
    const texts = await prisma.notification.findMany({ where: { category: 'broadcast', channel: 'SMS' } });
    expect(texts).toHaveLength(1);
    expect(texts[0]).toMatchObject({ status: 'NOT_CONFIGURED', recipientPhone: '(555) 010-0101' });
  });

  it('a list cannot widen the sender’s reach: a store-bound sender reaches only their store’s people on it', async () => {
    const { north, people } = await world();
    const [ana, , cy] = people;
    const { user: ops } = await createUser({ role: 'OPERATIONS_MANAGER' });
    await prisma.user.update({ where: { id: ops.id }, data: { scopeSiteIds: [north.id] } });
    const o = await loginAs(agent(), ops.email);
    const count = await o.post('/broadcasts/audience-count').send({ recipientAssociateIds: [ana!.id, cy!.id] });
    expect(count.body.people).toBe(1);
    const created = await o.post('/broadcasts').send({ title: 'Hi', body: 'x', recipientAssociateIds: [ana!.id, cy!.id] });
    const sent = await o.post(`/broadcasts/${created.body.id}/send`);
    expect(sent.body.recipientCount).toBe(1);
    const receipts = await prisma.broadcastReceipt.findMany({ where: { broadcastId: created.body.id } });
    expect(receipts.map((r) => r.userId)).toEqual([ana!.userId]);
  });
});
