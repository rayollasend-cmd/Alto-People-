import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';
import request, { type Test } from 'supertest';
import type TestAgent from 'supertest/lib/agent.js';
import { createApp } from '../../app.js';
import { env } from '../../config/env.js';
import { flushPendingNotifications } from '../../lib/notify.js';
import { handleCallOutText, twilioSignature } from '../../lib/callOutChannels.js';
import { DEFAULT_TEST_PASSWORD, createAssociate, createClient, createUser, prisma, truncateAll } from '../../../test/db.js';

/**
 * Call-outs, handled: from the app, a text, or the phone line — the absence
 * recorded, the policy applied (never discipline), cover started, the lead
 * told, the worker answered; one per shift however many times they say it.
 */

const app = () => createApp();
const H = 3_600_000;

beforeEach(async () => {
  await truncateAll();
});
afterEach(() => {
  env.TWILIO_AUTH_TOKEN = undefined;
  env.TWILIO_WEBHOOK_BASE_URL = undefined;
});
afterAll(async () => {
  await prisma.$disconnect();
});

async function loginAs(email: string): Promise<TestAgent<Test>> {
  const a = request.agent(app());
  const r = await a.post('/auth/login').send({ email, password: DEFAULT_TEST_PASSWORD });
  if (r.status !== 200) throw new Error(`login failed: ${r.status}`);
  return a;
}

async function world(startsInHours = 20) {
  const client = await createClient('Coastal');
  const store = await prisma.site.findFirstOrThrow({ where: { clientId: client.id } });
  const ana = await createAssociate({ firstName: 'Ana', lastName: 'Lopez' });
  await prisma.associate.update({ where: { id: ana.id }, data: { phone: '(850) 555-0101' } });
  await prisma.associateAssignment.create({ data: { associateId: ana.id, locationId: store.id, startedAt: new Date(Date.now() - 30 * 24 * H) } });
  const { user: anaUser } = await createUser({ role: 'ASSOCIATE', associateId: ana.id, email: 'ana@example.com' });
  const { user: lead } = await createUser({ role: 'SHIFT_SUPERVISOR', clientId: client.id, email: 'lead@example.com' });
  await prisma.user.update({ where: { id: lead.id }, data: { locationId: store.id } });
  const startsAt = new Date(Date.now() + startsInHours * H);
  const shift = await prisma.shift.create({
    data: { clientId: client.id, locationId: store.id, position: 'Cashier', startsAt, endsAt: new Date(startsAt.getTime() + 8 * H), status: 'ASSIGNED', assignedAssociateId: ana.id, publishedAt: new Date() },
  });
  return { client, store, ana, anaUser, lead, shift };
}

describe('from the app', () => {
  it('records it, applies the policy, starts cover, tells the lead — once', async () => {
    const w = await world();
    const a = await loginAs(w.anaUser.email);
    const r = await a.post('/me/call-outs').send({ shiftId: w.shift.id, reason: 'FAMILY', note: 'Kid is sick' });
    expect(r.status).toBe(201);
    expect(r.body.outcome).toBe('confirmed');
    expect(r.body.message).toMatch(/called out/);

    const shift = await prisma.shift.findUniqueOrThrow({ where: { id: w.shift.id } });
    expect(shift).toMatchObject({ status: 'OPEN', assignedAssociateId: null });
    const co = await prisma.callOut.findFirstOrThrow({ where: { shiftId: w.shift.id } });
    expect(co).toMatchObject({ channel: 'APP', reason: 'FAMILY', status: 'CONFIRMED', late: false, excused: false });
    expect((co.coverSteps as Array<{ key: string }>).map((s) => s.key)).toEqual(['post', 'bench', 'agent']);
    const ev = await prisma.attendanceEvent.findMany({ where: { shiftId: w.shift.id } });
    expect(ev).toHaveLength(1);
    expect(ev[0]).toMatchObject({ kind: 'CALL_OUT', excusedAt: null });

    // Saying it again changes nothing.
    const again = await a.post('/me/call-outs').send({ shiftId: w.shift.id, reason: 'SICK' });
    expect(again.status).toBe(200);
    expect(again.body.outcome).toBe('duplicate');
    expect(await prisma.attendanceEvent.count({ where: { shiftId: w.shift.id } })).toBe(1);

    await flushPendingNotifications();
    const told = await prisma.notification.findFirst({ where: { recipientUserId: w.lead.id, subject: { contains: 'Call-out: Ana Lopez' } } });
    expect(told?.body).toMatch(/Cover is under way/);
  });

  it('bereavement and accrued sick time are excused; a call-out inside two hours is late', async () => {
    const w = await world(1);
    await prisma.timeOffBalance.create({ data: { associateId: w.ana.id, category: 'SICK', balanceMinutes: 600 } });
    const a = await loginAs(w.anaUser.email);
    expect((await a.post('/me/call-outs').send({ shiftId: w.shift.id, reason: 'SICK' })).status).toBe(201);
    const co = await prisma.callOut.findFirstOrThrow({ where: { shiftId: w.shift.id } });
    expect(co).toMatchObject({ late: true, excused: true });
    expect(co.excusedWhy).toMatch(/sick time/);
    const ev = await prisma.attendanceEvent.findFirstOrThrow({ where: { shiftId: w.shift.id } });
    expect(ev.excusedAt).not.toBeNull();
  });

  it('refuses a shift that has started, or someone else’s', async () => {
    const w = await world(-1);
    const a = await loginAs(w.anaUser.email);
    expect((await a.post('/me/call-outs').send({ shiftId: w.shift.id, reason: 'SICK' })).status).toBe(409);
    const other = await createAssociate({ firstName: 'Bo', lastName: 'Other' });
    const theirs = await prisma.shift.create({ data: { clientId: w.client.id, position: 'Stocker', startsAt: new Date(Date.now() + 5 * H), endsAt: new Date(Date.now() + 9 * H), status: 'ASSIGNED', assignedAssociateId: other.id } });
    expect((await a.post('/me/call-outs').send({ shiftId: theirs.id, reason: 'SICK' })).status).toBe(404);
  });
});

describe('by WhatsApp or text', () => {
  it('asks for a YES first, then applies it; NO keeps the shift; a repeat is a no-op', async () => {
    const w = await world();
    const asked = await handleCallOutText({ associateId: w.ana.id, text: "I can't make it today, I'm sick", channel: 'SMS', language: 'es' });
    expect(asked?.outcome).toBe('asked');
    expect(asked?.reply).toMatch(/Responde SÍ/);
    expect((await prisma.shift.findUniqueOrThrow({ where: { id: w.shift.id } })).assignedAssociateId).toBe(w.ana.id);
    expect(await prisma.callOut.findFirstOrThrow({ where: { shiftId: w.shift.id } })).toMatchObject({ status: 'PENDING', reason: 'SICK' });

    const kept = await handleCallOutText({ associateId: w.ana.id, text: 'no', channel: 'SMS', language: 'en' });
    expect(kept?.outcome).toBe('kept');
    expect((await prisma.callOut.findFirstOrThrow({ where: { shiftId: w.shift.id } })).status).toBe('CANCELLED');

    await handleCallOutText({ associateId: w.ana.id, text: 'calling out, car broke down', channel: 'WHATSAPP', language: 'en' });
    const yes = await handleCallOutText({ associateId: w.ana.id, text: 'YES', channel: 'WHATSAPP', language: 'en' });
    expect(yes?.outcome).toBe('confirmed');
    expect((await prisma.callOut.findFirstOrThrow({ where: { shiftId: w.shift.id } })).reason).toBe('TRANSPORT');
    expect((await prisma.shift.findUniqueOrThrow({ where: { id: w.shift.id } })).status).toBe('OPEN');

    // Nothing else left to call out of; an unrelated message isn't ours.
    expect((await handleCallOutText({ associateId: w.ana.id, text: "can't come in", channel: 'SMS', language: 'en' }))?.outcome).toBe('no_shift');
    expect(await handleCallOutText({ associateId: w.ana.id, text: 'when is payday?', channel: 'SMS', language: 'en' })).toBeNull();
    expect(await prisma.attendanceEvent.count({ where: { shiftId: w.shift.id } })).toBe(1);
  });
});

describe('the leads’ view', () => {
  it('shows today’s call-outs in reach with how cover is going', async () => {
    const w = await world();
    const a = await loginAs(w.anaUser.email);
    await a.post('/me/call-outs').send({ shiftId: w.shift.id, reason: 'EMERGENCY' });
    const lead = await loginAs(w.lead.email);
    const r = await lead.get('/call-outs');
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ total: 1, looking: 1, covered: 0 });
    expect(r.body.items[0]).toMatchObject({ name: 'Ana Lopez', reason: 'EMERGENCY', cover: { state: 'looking' } });

    // Someone takes it: covered, by name.
    const bo = await createAssociate({ firstName: 'Bo', lastName: 'Cover' });
    await prisma.shift.update({ where: { id: w.shift.id }, data: { status: 'ASSIGNED', assignedAssociateId: bo.id } });
    const after = await lead.get('/call-outs');
    expect(after.body.items[0].cover).toMatchObject({ state: 'covered', by: 'Bo Cover' });

    // Another client's lead sees none of it; a worker can't open it.
    const other = await createClient('Elsewhere');
    const { user: otherLead } = await createUser({ role: 'SHIFT_SUPERVISOR', clientId: other.id, email: 'other@example.com' });
    expect((await (await loginAs(otherLead.email)).get('/call-outs')).body.total).toBe(0);
    expect((await a.get('/call-outs')).status).toBe(403);
  });

  it('a lead records one taken by phone', async () => {
    const w = await world();
    const lead = await loginAs(w.lead.email);
    const r = await lead.post('/call-outs').send({ associateId: w.ana.id, shiftId: w.shift.id, reason: 'SICK' });
    expect(r.status).toBe(201);
    expect(await prisma.callOut.findFirstOrThrow({ where: { shiftId: w.shift.id } })).toMatchObject({ channel: 'STAFF', createdById: w.lead.id });
  });
});

describe('the phone line', () => {
  const BASE = 'https://api.alto.test';
  const signed = (path: string, params: Record<string, string>) => twilioSignature('tw-test-token', `${BASE}${path}`, params);

  it('is off without a token and refuses unsigned requests', async () => {
    expect((await request(app()).post('/voice/inbound').type('form').send({ From: '+18505550101' })).status).toBe(503);
    env.TWILIO_AUTH_TOKEN = 'tw-test-token';
    env.TWILIO_WEBHOOK_BASE_URL = BASE;
    expect((await request(app()).post('/voice/inbound').type('form').send({ From: '+18505550101' }).set('X-Twilio-Signature', 'forged')).status).toBe(403);
  });

  it('identifies the caller, walks the menu, and records the call-out', async () => {
    const w = await world();
    env.TWILIO_AUTH_TOKEN = 'tw-test-token';
    env.TWILIO_WEBHOOK_BASE_URL = BASE;
    const body = { From: '+18505550101', CallSid: 'CA1' };
    const first = await request(app()).post('/voice/inbound').type('form').send(body).set('X-Twilio-Signature', signed('/voice/inbound', body));
    expect(first.status).toBe(200);
    expect(first.text).toMatch(/press 1/i);
    const next = /action="([^"]+)"/.exec(first.text)![1]!.replace(/&amp;/g, '&');

    const one = { Digits: '1', CallSid: 'CA1' };
    const menu = await request(app()).post(next).type('form').send(one).set('X-Twilio-Signature', signed(next, one));
    expect(menu.text).toMatch(/Press 1 for sick/);
    const reasonUrl = /action="([^"]+)"/.exec(menu.text)![1]!.replace(/&amp;/g, '&');

    const sick = { Digits: '1', CallSid: 'CA1' };
    const done = await request(app()).post(reasonUrl).type('form').send(sick).set('X-Twilio-Signature', signed(reasonUrl, sick));
    expect(done.text).toMatch(/called out/);
    expect(await prisma.callOut.findFirstOrThrow({ where: { shiftId: w.shift.id } })).toMatchObject({ channel: 'VOICE', reason: 'SICK', status: 'CONFIRMED' });

    // A tampered step (someone else's shift) is refused by the signed state.
    const forged = reasonUrl.replace(/s=[^&]+/, 's=tampered');
    const bad = await request(app()).post(forged).type('form').send(sick).set('X-Twilio-Signature', signed(forged, sick));
    expect(bad.text).toMatch(/didn’t get that|didn't get that/);
  });

  it('an unknown number is told how to fix it', async () => {
    env.TWILIO_AUTH_TOKEN = 'tw-test-token';
    env.TWILIO_WEBHOOK_BASE_URL = BASE;
    const body = { From: '+13055550199' };
    const r = await request(app()).post('/voice/inbound').type('form').send(body).set('X-Twilio-Signature', signed('/voice/inbound', body));
    expect(r.text).toMatch(/couldn’t match this phone number/);
  });
});
