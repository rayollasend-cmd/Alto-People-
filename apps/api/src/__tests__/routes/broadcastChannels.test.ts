import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';
import request, { type Test } from 'supertest';
import type TestAgent from 'supertest/lib/agent.js';
import { createApp } from '../../app.js';
import { DEFAULT_TEST_PASSWORD, createAssociate, createUser, prisma, truncateAll } from '../../../test/db.js';
import { flushPendingNotifications } from '../../lib/notify.js';
import { setSmsTransportForTests } from '../../lib/sms.js';

/**
 * Audit 2026-10-21 Tier 3: broadcast channels were stored and ignored —
 * send-now fanned out bell + email regardless. Now the chosen channels are
 * the channels delivered, each counted onto Broadcast.delivery, and a
 * channel with no provider behind it says so instead of counting as sent.
 */

beforeEach(async () => {
  await truncateAll();
});
afterEach(() => setSmsTransportForTests(null));
afterAll(async () => {
  await prisma.$disconnect();
});

async function loginAs(email: string): Promise<TestAgent<Test>> {
  const a = request.agent(createApp());
  const r = await a.post('/auth/login').send({ email, password: DEFAULT_TEST_PASSWORD });
  if (r.status !== 200) throw new Error(`login failed: ${r.status}`);
  return a;
}

async function world() {
  const { user: hr } = await createUser({ role: 'HR_ADMINISTRATOR' });
  const a1 = await createAssociate({ firstName: 'Ana', lastName: 'Lopez' });
  const a2 = await createAssociate({ firstName: 'Ben', lastName: 'Ray' });
  await prisma.associate.update({ where: { id: a1.id }, data: { phone: '(555) 010-0101' } });
  // a2: no phone, has an account
  const { user: u1 } = await createUser({ role: 'ASSOCIATE', email: a1.email, associateId: a1.id });
  const { user: u2 } = await createUser({ role: 'ASSOCIATE', email: a2.email, associateId: a2.id });
  const hrAgent = await loginAs(hr.email);
  return { hr, hrAgent, a1, a2, u1, u2 };
}

async function sendBroadcast(agent: TestAgent<Test>, channels: string[]) {
  const created = await agent.post('/broadcasts').send({ title: 'Doors open at 5', body: 'Side door today.', channels });
  expect(created.status).toBe(201);
  const sent = await agent.post(`/broadcasts/${created.body.id}/send`);
  expect(sent.status).toBe(200);
  await flushPendingNotifications();
  const row = await prisma.broadcast.findUniqueOrThrow({ where: { id: created.body.id } });
  return { id: created.body.id as string, response: sent.body as Record<string, unknown>, delivery: row.delivery as Record<string, unknown> | null };
}

describe('POST /broadcasts/:id/send honours the chosen channels', () => {
  it('IN_APP only: a bell row per account, no email, and the counts on the broadcast', async () => {
    const w = await world();
    const { delivery } = await sendBroadcast(w.hrAgent, ['IN_APP']);
    const rows = await prisma.notification.findMany({ where: { category: 'broadcast' } });
    expect(rows.map((r) => r.channel).sort()).toEqual(['IN_APP', 'IN_APP']);
    expect(delivery).toMatchObject({ channels: ['IN_APP'], recipients: 2, counts: { IN_APP: { sent: 2 } } });
    expect((delivery as { counts: Record<string, unknown> }).counts.EMAIL).toBeUndefined();
  });

  it('EMAIL only: no bell row; an email row per account', async () => {
    const w = await world();
    const { delivery } = await sendBroadcast(w.hrAgent, ['EMAIL']);
    const rows = await prisma.notification.findMany({ where: { category: 'broadcast' } });
    expect(rows.every((r) => r.channel === 'EMAIL')).toBe(true);
    expect(rows).toHaveLength(2);
    expect(delivery).toMatchObject({ counts: { EMAIL: { sent: 2 } } });
  });

  it('SMS with no provider: NOT_CONFIGURED rows, the broadcast says texting is off, the send answer says it up front', async () => {
    const w = await world();
    const { response, delivery } = await sendBroadcast(w.hrAgent, ['IN_APP', 'SMS']);
    expect(response.notConfigured).toMatchObject({ SMS: expect.stringMatching(/Texting isn’t connected/) });
    const sms = await prisma.notification.findMany({ where: { category: 'broadcast', channel: 'SMS' } });
    expect(sms).toHaveLength(1);
    expect(sms[0]).toMatchObject({ status: 'NOT_CONFIGURED', recipientPhone: '(555) 010-0101', recipientUserId: w.u1.id });
    expect(delivery).toMatchObject({
      notConfigured: { SMS: expect.stringMatching(/Texting isn’t connected/) },
      counts: { IN_APP: { sent: 2 }, SMS: { not_configured: 1, no_phone: 1 } },
    });
  });

  it('SMS with a provider: one text per phone on file, counted as sent with the SID on the row', async () => {
    const texts: Array<{ to: string; body: string }> = [];
    setSmsTransportForTests(async (m) => {
      texts.push(m);
      return { sid: `SM-${texts.length}`, status: 'queued' };
    });
    const w = await world();
    const { response, delivery } = await sendBroadcast(w.hrAgent, ['SMS']);
    expect(response).toMatchObject({ recipientCount: 2, phoneCount: 1, notConfigured: {} });
    expect(texts).toEqual([{ to: '+15550100101', body: 'Doors open at 5\nSide door today.' }]);
    const rows = await prisma.notification.findMany({ where: { category: 'broadcast' } });
    expect(rows).toHaveLength(1); // no bell rows: IN_APP was not chosen
    expect(rows[0]).toMatchObject({ channel: 'SMS', status: 'SENT', externalRef: 'SM-1' });
    expect(delivery).toMatchObject({ counts: { SMS: { sent: 1, no_phone: 1 } }, notConfigured: {} });
    // The admin list carries the counts for the sent log.
    const list = await w.hrAgent.get('/broadcasts');
    expect(list.body.broadcasts[0].delivery).toMatchObject({ counts: { SMS: { sent: 1 } } });
  });

  it('PUSH with no push transport: counted not_configured, nothing claimed sent', async () => {
    const w = await world();
    const { response, delivery } = await sendBroadcast(w.hrAgent, ['PUSH']);
    expect(response.notConfigured).toMatchObject({ PUSH: expect.stringMatching(/Push isn’t set up/) });
    expect(delivery).toMatchObject({ counts: { PUSH: { not_configured: 2 } }, notConfigured: { PUSH: expect.any(String) } });
    expect(await prisma.notification.count({ where: { category: 'broadcast' } })).toBe(0);
  });
});
