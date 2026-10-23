import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { agent, loginAs } from '../../../test/http.js';
import { createUser, prisma, truncateAll } from '../../../test/db.js';
import { flushPendingNotifications } from '../../lib/notify.js';

/**
 * Support, F500 G5: the person who asked can answer back on their own
 * request (a reply arrived as plain text with no way to answer it), and
 * "My requests" says how long an answer typically takes — from the record,
 * or nothing when there is too little to go on.
 */

beforeEach(async () => {
  await truncateAll();
});
afterAll(async () => {
  await prisma.$disconnect();
});

describe('support follow-ups', () => {
  it('the requester answers back: the request reopens and the platform inbox hears it; nobody else can', async () => {
    const { user: platformAdmin } = await createUser({ role: 'HR_ADMINISTRATOR' });
    const { user: asker } = await createUser({ role: 'MANAGER' });
    const { user: other } = await createUser({ role: 'MANAGER' });
    const a = await loginAs(agent(), asker.email);
    const asked = await a.post('/support').send({ category: 'QUESTION', subject: 'Export the roster', body: 'How do I export my roster?' });
    expect(asked.status).toBe(201);
    await prisma.supportRequest.update({ where: { id: asked.body.id }, data: { status: 'RESOLVED', reply: 'Use Export on the roster page.', resolvedAt: new Date() } });

    const follow = await a.post(`/support/${asked.body.id}/followup`).send({ body: 'There is no Export on my roster page.' });
    expect(follow.status).toBe(201);
    expect(follow.body.status).toBe('OPEN');
    const row = await prisma.supportRequest.findUniqueOrThrow({ where: { id: asked.body.id } });
    expect(row.body).toMatch(/How do I export my roster\?\n\n— Follow-up \d{4}-\d{2}-\d{2}: There is no Export on my roster page\.$/);
    expect(row.resolvedAt).toBeNull();
    await flushPendingNotifications();
    expect(await prisma.notification.count({ where: { recipientUserId: platformAdmin.id, channel: 'IN_APP', subject: 'Support follow-up: Export the roster' } })).toBe(1);

    // Someone else's request is not theirs to answer.
    const b = await loginAs(agent(), other.email);
    expect((await b.post(`/support/${asked.body.id}/followup`).send({ body: 'Me too' })).status).toBe(404);
  });

  it('"My requests" carries the typical time to resolve — the median of the last 90 days, or null with too little to go on', async () => {
    const { user: asker } = await createUser({ role: 'MANAGER' });
    const a = await loginAs(agent(), asker.email);
    expect((await a.get('/support/mine')).body.typicalResolveHours).toBeNull();
    const now = Date.now();
    for (const hours of [2, 6, 30]) {
      await prisma.supportRequest.create({
        data: { requesterUserId: asker.id, category: 'QUESTION', subject: `Q${hours}`, body: 'A question here', status: 'RESOLVED', createdAt: new Date(now - 48 * 3_600_000), resolvedAt: new Date(now - 48 * 3_600_000 + hours * 3_600_000) },
      });
    }
    expect((await a.get('/support/mine')).body.typicalResolveHours).toBe(6);
  });
});
